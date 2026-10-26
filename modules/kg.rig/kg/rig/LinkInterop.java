package kg.rig;

import java.lang.foreign.Arena;
import java.lang.foreign.FunctionDescriptor;
import java.lang.foreign.Linker;
import java.lang.foreign.MemoryLayout;
import java.lang.foreign.MemorySegment;
import java.lang.foreign.SymbolLookup;
import java.lang.foreign.ValueLayout;
import java.lang.invoke.MethodHandle;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.SplittableRandom;
import java.util.zip.CRC32;

/**
 * Proves the on-chip C link (firmware-support/kg_link.c) and the Java link agree byte for byte:
 * CRC, encoding, decoding, and recovery after corruption. Runs in its own process.
 * usage: LinkInterop <libkglink.so> ; exit 0 = all agree, 1 = disagreement, 2 = error
 */
public final class LinkInterop {
    private static final MemoryLayout FRAME = MemoryLayout.structLayout(
            ValueLayout.JAVA_BYTE.withName("type"), MemoryLayout.paddingLayout(1),
            ValueLayout.JAVA_SHORT.withName("seq"), ValueLayout.JAVA_SHORT.withName("len"),
            MemoryLayout.sequenceLayout(256, ValueLayout.JAVA_BYTE).withName("payload"));
    private static final long DECODER_BYTES = 512; /* larger than sizeof(kg_decoder_t) = 280 */

    private LinkInterop() {
    }

    public static void main(String[] a) {
        if (a.length != 1) {
            System.err.println("usage: LinkInterop <libkglink.so>");
            System.exit(2);
        }
        try {
            System.exit(run(Path.of(a[0])));
        } catch (Throwable t) {
            System.err.println("interop error: " + t);
            System.exit(2);
        }
    }

    static int run(Path lib) throws Throwable {
        try (Arena arena = Arena.ofConfined()) {
            Linker l = Linker.nativeLinker();
            SymbolLookup s = SymbolLookup.libraryLookup(lib, arena);
            MethodHandle crc = l.downcallHandle(s.find("kg_crc32").orElseThrow(),
                    FunctionDescriptor.of(ValueLayout.JAVA_INT, ValueLayout.ADDRESS, ValueLayout.JAVA_INT));
            MethodHandle init = l.downcallHandle(s.find("kg_decoder_init").orElseThrow(),
                    FunctionDescriptor.ofVoid(ValueLayout.ADDRESS));
            MethodHandle feed = l.downcallHandle(s.find("kg_decoder_feed").orElseThrow(),
                    FunctionDescriptor.of(ValueLayout.JAVA_INT, ValueLayout.ADDRESS, ValueLayout.JAVA_BYTE, ValueLayout.ADDRESS));
            MethodHandle enc = l.downcallHandle(s.find("kg_frame_encode").orElseThrow(),
                    FunctionDescriptor.of(ValueLayout.JAVA_SHORT, ValueLayout.ADDRESS, ValueLayout.ADDRESS, ValueLayout.JAVA_SHORT));
            MemorySegment dec = arena.allocate(DECODER_BYTES, 8);
            MemorySegment fr = arena.allocate(FRAME);
            MemorySegment wire = arena.allocate(512, 8);
            init.invokeExact(dec);
            SplittableRandom rnd = new SplittableRandom(20261026L);
            int failures = 0;
            int rejected = 0;
            for (int i = 0; i < 500; i++) {
                byte[] payload = new byte[rnd.nextInt(0, 257)];
                for (int k = 0; k < payload.length; k++) {
                    payload[k] = (byte) rnd.nextInt(256);
                }
                Frame jf = new Frame(rnd.nextInt(256), rnd.nextInt(65536), payload);
                byte[] jw = jf.encode();

                /* 1. CRC agrees */
                MemorySegment p = arena.allocate(Math.max(1, payload.length), 1);
                MemorySegment.copy(payload, 0, p, ValueLayout.JAVA_BYTE, 0, payload.length);
                CRC32 c = new CRC32();
                c.update(payload);
                if ((int) crc.invokeExact(p, payload.length) != (int) c.getValue()) {
                    failures++;
                }

                /* 2. C encodes exactly what Java encodes */
                fr.set(ValueLayout.JAVA_BYTE, 0, (byte) jf.type());
                fr.set(ValueLayout.JAVA_SHORT, 2, (short) jf.seq());
                fr.set(ValueLayout.JAVA_SHORT, 4, (short) payload.length);
                MemorySegment.copy(payload, 0, fr, ValueLayout.JAVA_BYTE, 6, payload.length);
                short n = (short) enc.invokeExact(fr, wire, (short) 512);
                byte[] cw = wire.asSlice(0, n & 0xFFFF).toArray(ValueLayout.JAVA_BYTE);
                if (!Arrays.equals(cw, jw)) {
                    failures++;
                }

                /* 3. A corrupted copy is rejected by C, then the good frame right after it is decoded */
                byte[] bad = jw.clone();
                bad[rnd.nextInt(2, bad.length)] ^= (byte) (1 << rnd.nextInt(8));
                int got = 0;
                MemorySegment out = arena.allocate(FRAME);
                for (byte x : bad) {
                    got += (int) feed.invokeExact(dec, x, out);
                }
                rejected += got == 0 ? 1 : 0;
                /* A corrupted length field can make the decoder wait for more bytes; idle line bytes
                   (0x00) let it finish, fail the CRC, re-scan and find the good frame it already holds. */
                int good = 0;
                for (byte x : jw) {
                    good += (int) feed.invokeExact(dec, x, out);
                }
                for (int k = 0; k < 300 && good == 0; k++) {
                    good += (int) feed.invokeExact(dec, (byte) 0, out);
                }
                if (good != 1 || (out.get(ValueLayout.JAVA_BYTE, 0) & 0xFF) != jf.type()
                        || (out.get(ValueLayout.JAVA_SHORT, 2) & 0xFFFF) != jf.seq()
                        || (out.get(ValueLayout.JAVA_SHORT, 4) & 0xFFFF) != payload.length
                        || !Arrays.equals(out.asSlice(6, payload.length).toArray(ValueLayout.JAVA_BYTE), payload)) {
                    failures++;
                }

                /* 4. Java decodes what C encodes */
                Frame.Decoder jd = new Frame.Decoder();
                Frame back = null;
                for (byte x : cw) {
                    Frame f = jd.feed(x);
                    if (f != null) {
                        back = f;
                    }
                }
                if (back == null || back.type() != jf.type() || back.seq() != jf.seq() || !Arrays.equals(back.payload(), payload)) {
                    failures++;
                }
            }
            System.out.println("interop: 500 random frames, " + failures + " disagreements between C and Java, "
                    + rejected + "/500 corrupted frames rejected by the C decoder");
            return failures == 0 && rejected == 500 ? 0 : 1;
        }
    }
}
