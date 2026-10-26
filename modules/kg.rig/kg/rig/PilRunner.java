package kg.rig;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import kg.core.Interface;
import kg.sil.Engine;

/**
 * PIL on the PC side. The plant and the fault timeline run in the shared Engine on the PC; the
 * firmware runs on the board (real or simulated). Each tick is one STEP request over the link.
 *
 * Protocol v2 payloads (little-endian):
 *   HELLO      ver u8
 *   HELLO_ACK  ver u8, chip u32, name (len u8 + bytes), rev (len u8 + bytes), fw sha256[32], n_in u8, n_out u8
 *   INIT       latch u8 (0 max, 1 last, 2 safe), n_out u8, safe f32[n_out], max f32[n_out]
 *   STEP       tick u32, wd_on u8, n_in u8, in f32[n_in]
 *   STEP_ACK   tick u32, wd u8, n_out u8, out f32[n_out], state_hash u32, exec_ns u32
 */
public final class PilRunner {
    public record Identity(int protocol, long chipId, String board, String revision, String firmwareHash, int nIn, int nOut) {
        public String describe() {
            return board + " " + revision + ", chip 0x" + Long.toHexString(chipId) + ", firmware "
                    + firmwareHash.substring(0, 12) + "..., " + nIn + " in / " + nOut + " out, protocol v" + protocol;
        }
    }

    private PilRunner() {
    }

    public static Identity hello(Link link) throws Link.LinkLost {
        Frame r = link.requestSlow(Frame.HELLO, new byte[] {(byte) Frame.VERSION}, Frame.HELLO_ACK,
                java.time.Duration.ofSeconds(5));
        try {
            ByteBuffer b = r.body();
            int proto = b.get() & 0xFF;
            long chip = b.getInt() & 0xFFFF_FFFFL;
            byte[] n = new byte[b.get() & 0xFF];
            b.get(n);
            byte[] v = new byte[b.get() & 0xFF];
            b.get(v);
            byte[] h = new byte[32];
            b.get(h);
            int nIn = b.get() & 0xFF;
            int nOut = b.get() & 0xFF;
            return new Identity(proto, chip, new String(n, StandardCharsets.US_ASCII),
                    new String(v, StandardCharsets.US_ASCII), HexFormat.of().formatHex(h), nIn, nOut);
        } catch (RuntimeException e) {
            throw new Link.LinkLost("malformed HELLO reply");
        }
    }

    /** Compares what is connected with what the project expects. Empty list = identity confirmed. */
    public static List<String> checkIdentity(Identity id, BoardSpec spec, String expectedFirmwareHash, Interface itf) {
        List<String> p = new ArrayList<>();
        if (id.protocol() != Frame.VERSION) {
            p.add("board speaks protocol v" + id.protocol() + ", expected v" + Frame.VERSION);
        }
        if (id.chipId() != spec.chipId) {
            p.add("wrong chip: found 0x" + Long.toHexString(id.chipId()) + ", expected 0x" + Long.toHexString(spec.chipId));
        }
        if (!id.board().equals(spec.board) || !id.revision().equals(spec.revision)) {
            p.add("wrong board: found " + id.board() + " " + id.revision() + ", expected " + spec.board + " " + spec.revision);
        }
        if (!id.firmwareHash().equals(expectedFirmwareHash)) {
            p.add("board is running different firmware than this build (" + id.firmwareHash().substring(0, 12) + "...)");
        }
        if (itf != null && (id.nIn() != itf.inputs.size() || id.nOut() != itf.outputs.size())) {
            p.add("board firmware has " + id.nIn() + " inputs / " + id.nOut() + " outputs; interface.cfg declares "
                    + itf.inputs.size() + " / " + itf.outputs.size());
        }
        return p;
    }

    /** Best effort: tells the board to force every output safe. Returns true only if the board confirmed. */
    public static boolean commandSafe(Link link) {
        try {
            link.request(Frame.SAFE, new byte[0], Frame.SAFE_ACK);
            return true;
        } catch (Link.LinkLost e) {
            return false;
        }
    }

    /** Engine stepper that runs each tick on the board over the link. */
    public static final class Remote implements Engine.Stepper {
        private final Link link;
        private final int nIn;
        private final int nOut;
        private long maxExecNs;
        private final List<Long> samples = new ArrayList<>();

        public Remote(Link link, int nIn, int nOut) {
            this.link = link;
            this.nIn = nIn;
            this.nOut = nOut;
        }

        public long maxExecNs() {
            return maxExecNs;
        }

        /** Step-time percentile in ns (0..100), over all steps so far. */
        public long percentileNs(double p) {
            if (samples.isEmpty()) {
                return 0;
            }
            List<Long> s = new ArrayList<>(samples);
            java.util.Collections.sort(s);
            return s.get((int) Math.min(s.size() - 1, Math.floor(p / 100.0 * s.size())));
        }

        @Override
        public void init(float[] safe, Interface.HangLatch latch, float[] max) throws Link.LinkLost {
            ByteBuffer b = Frame.buf(2 + 8 * nOut);
            b.put((byte) latch.ordinal()).put((byte) nOut);
            for (float x : safe) {
                b.putFloat(x);
            }
            for (float x : max) {
                b.putFloat(x);
            }
            link.request(Frame.INIT, b.array(), Frame.INIT_ACK);
        }

        @Override
        public Engine.Result step(int tick, float[] in, boolean wdOn) throws Link.LinkLost {
            ByteBuffer b = Frame.buf(6 + 4 * nIn);
            b.putInt(tick).put((byte) (wdOn ? 1 : 0)).put((byte) nIn);
            for (float x : in) {
                b.putFloat(x);
            }
            Frame r = link.request(Frame.STEP, b.array(), Frame.STEP_ACK);
            ByteBuffer q = r.body();
            try {
                int t = q.getInt();
                if (t != tick) {
                    throw new Link.LinkLost("board answered tick " + t + " for tick " + tick);
                }
                boolean wd = q.get() != 0;
                int n = q.get() & 0xFF;
                if (n != nOut) {
                    throw new Link.LinkLost("board returned " + n + " outputs, expected " + nOut);
                }
                float[] out = new float[n];
                for (int i = 0; i < n; i++) {
                    out[i] = q.getFloat();
                }
                int hash = q.getInt();
                long ns = q.getInt() & 0xFFFF_FFFFL;
                maxExecNs = Math.max(maxExecNs, ns);
                samples.add(ns);
                return new Engine.Result(out, wd, hash, ns);
            } catch (java.nio.BufferUnderflowException e) {
                throw new Link.LinkLost("short STEP reply");
            }
        }

        @Override
        public void hang() throws Link.LinkLost {
            link.request(Frame.HANG, new byte[0], Frame.HANG_ACK);
        }
    }
}
