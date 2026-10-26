package kg.rig;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.HexFormat;
import kg.core.Hashing;
import kg.sil.Firmware;
import kg.sil.WatchdogModel;

/**
 * Simulated target board. Speaks exactly the protocol a real chip running
 * firmware-support/kg_pil_target.c speaks, over stdin/stdout, and runs the firmware through the
 * same library as SIL. Fault injection corrupts bytes in both directions to prove the link
 * recovers. exec_ns is the host CPU time of fw_step: a proxy, not target timing.
 *
 * usage: VirtualBoard <libfw> <n_in> <n_out> <name> <rev> <chip-hex> <corrupt-per-million> <seed>
 */
public final class VirtualBoard {
    private VirtualBoard() {
    }

    public static void main(String[] a) throws Throwable {
        if (a.length != 8) {
            System.err.println("usage: VirtualBoard <libfw> <n_in> <n_out> <name> <rev> <chip-hex> <corrupt-ppm> <seed>");
            System.exit(2);
        }
        Path lib = Path.of(a[0]);
        int nIn = Integer.parseInt(a[1]);
        int nOut = Integer.parseInt(a[2]);
        String name = a[3];
        String rev = a[4];
        int chip = (int) BoardSpec.hex(a[5]);
        int ppm = Integer.parseInt(a[6]);
        long rng = Long.parseLong(a[7]) | 1L;
        byte[] fwHash = HexFormat.of().parseHex(Hashing.sha256(lib));
        InputStream in = new BufferedInputStream(new FileInputStream(FileDescriptor.in));
        OutputStream out = new BufferedOutputStream(new FileOutputStream(FileDescriptor.out));
        Frame.Decoder dec = new Frame.Decoder();
        WatchdogModel wd = null;
        boolean hung = false;
        boolean safeMode = false;
        int latch = 0;
        float[] safe = new float[nOut];
        float[] max = new float[nOut];
        float[] last = new float[nOut];
        int lastSeq = -1;
        byte[] lastReply = null;
        try (Firmware fw = new Firmware(lib, nIn, nOut)) {
            int b;
            while ((b = in.read()) >= 0) {
                if (ppm > 0) {
                    rng = rng * 6364136223846793005L + 1442695040888963407L;
                    if ((int) ((rng >>> 33) % 1_000_000) < ppm) {
                        b ^= 0x10; /* corrupted on the way in: the board must not act on it */
                    }
                }
                Frame f = dec.feed(b);
                if (f == null) {
                    continue;
                }
                byte[] reply;
                if (f.seq() == lastSeq && lastReply != null) {
                    reply = lastReply; /* a retry: resend, never act twice */
                } else {
                    ByteBuffer p = f.body();
                    Frame r;
                    switch (f.type()) {
                        case Frame.HELLO -> {
                            byte[] n = name.getBytes(StandardCharsets.US_ASCII);
                            byte[] v = rev.getBytes(StandardCharsets.US_ASCII);
                            ByteBuffer o = Frame.buf(1 + 4 + 1 + n.length + 1 + v.length + 32 + 2);
                            o.put((byte) Frame.VERSION).putInt(chip).put((byte) n.length).put(n).put((byte) v.length).put(v)
                                    .put(fwHash).put((byte) nIn).put((byte) nOut);
                            r = new Frame(Frame.HELLO_ACK, f.seq(), o.array());
                        }
                        case Frame.INIT -> {
                            latch = p.get();
                            int n = p.get() & 0xFF;
                            if (n != nOut || latch < 0 || latch > 2) {
                                r = new Frame(Frame.NAK, f.seq(), new byte[] {3});
                                break;
                            }
                            for (int i = 0; i < nOut; i++) {
                                safe[i] = p.getFloat();
                            }
                            for (int i = 0; i < nOut; i++) {
                                max[i] = p.getFloat();
                            }
                            fw.init();
                            wd = new WatchdogModel(1, 2);
                            hung = false;
                            safeMode = false;
                            last = safe.clone();
                            r = new Frame(Frame.INIT_ACK, f.seq(), new byte[0]);
                        }
                        case Frame.STEP -> {
                            if (wd == null) {
                                r = new Frame(Frame.NAK, f.seq(), new byte[] {2});
                                break;
                            }
                            int tick = p.getInt();
                            boolean wdOn = p.get() != 0;
                            int n = p.get() & 0xFF;
                            if (n != nIn) {
                                r = new Frame(Frame.NAK, f.seq(), new byte[] {4});
                                break;
                            }
                            float[] inputs = new float[nIn];
                            for (int i = 0; i < nIn; i++) {
                                inputs[i] = p.getFloat();
                            }
                            if (wdOn) {
                                wd.tick();
                            }
                            float[] o;
                            long ns = 0;
                            if (hung) {
                                o = latch == 0 ? max.clone() : latch == 1 ? last.clone() : safe.clone();
                            } else {
                                long t0 = System.nanoTime();
                                o = fw.step(inputs);
                                ns = System.nanoTime() - t0;
                                last = o.clone();
                                if (wdOn) {
                                    wd.kick(fw.progressToken(tick));
                                }
                            }
                            if (wd.tripped() || safeMode) {
                                o = safe.clone();
                            }
                            ByteBuffer q = Frame.buf(4 + 1 + 1 + 4 * nOut + 4 + 4);
                            q.putInt(tick).put((byte) (wd.tripped() ? 1 : 0)).put((byte) nOut);
                            for (float x : o) {
                                q.putFloat(x);
                            }
                            q.putInt(fw.stateHash()).putInt((int) Math.min(ns, 0xFFFF_FFFFL));
                            r = new Frame(Frame.STEP_ACK, f.seq(), q.array());
                        }
                        case Frame.HANG -> {
                            hung = true;
                            r = new Frame(Frame.HANG_ACK, f.seq(), new byte[0]);
                        }
                        case Frame.SAFE -> {
                            safeMode = true;
                            r = new Frame(Frame.SAFE_ACK, f.seq(), new byte[0]);
                        }
                        case Frame.HEARTBEAT -> r = new Frame(Frame.HEARTBEAT_ACK, f.seq(), new byte[0]);
                        default -> r = new Frame(Frame.NAK, f.seq(), new byte[] {1});
                    }
                    reply = r.encode();
                    lastSeq = f.seq();
                    lastReply = reply;
                }
                byte[] wire = reply.clone();
                if (ppm > 0) {
                    for (int i = 0; i < wire.length; i++) {
                        rng = rng * 6364136223846793005L + 1442695040888963407L;
                        if ((int) ((rng >>> 33) % 1_000_000) < ppm) {
                            wire[i] ^= 0x01; /* corrupted on the way out: the PC must detect it */
                        }
                    }
                }
                out.write(wire);
                out.flush();
            }
        } catch (IOException e) {
            System.err.println("virtual board: " + e.getMessage());
        }
    }
}
