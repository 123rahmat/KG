package kg.rig;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.zip.CRC32;

/**
 * Kindgleam link protocol, version 2 (generic input and output arrays). Little-endian. Identical in firmware-support/kg_link.c.
 *
 *   0    1    2    3     4..5   6..7   8..8+len-1   last 4
 *   A5   5A   ver  type  seq    len    payload      CRC-32 over bytes 2 .. 8+len-1
 *
 * Payload is at most 256 bytes. Any length, version or CRC problem drops the frame.
 */
public record Frame(int type, int seq, byte[] payload) {
    public static final int SOF1 = 0xA5;
    public static final int SOF2 = 0x5A;
    public static final int VERSION = 2;
    public static final int MAX_PAYLOAD = 256;

    public static final int HELLO = 0x01;
    public static final int HELLO_ACK = 0x81;
    public static final int INIT = 0x02;
    public static final int INIT_ACK = 0x82;
    public static final int STEP = 0x03;
    public static final int STEP_ACK = 0x83;
    public static final int HANG = 0x04;      /* test builds only: firmware stops stepping */
    public static final int HANG_ACK = 0x84;
    public static final int SAFE = 0x05;      /* force all outputs to the safe state */
    public static final int SAFE_ACK = 0x85;
    public static final int HEARTBEAT = 0x06;
    public static final int HEARTBEAT_ACK = 0x86;
    public static final int NAK = 0xFF;

    public Frame {
        if (payload.length > MAX_PAYLOAD || type < 0 || type > 255 || seq < 0 || seq > 0xFFFF) {
            throw new IllegalArgumentException("invalid frame");
        }
        payload = payload.clone();
    }

    @Override
    public byte[] payload() {
        return payload.clone();
    }

    public ByteBuffer body() {
        return ByteBuffer.wrap(payload).order(ByteOrder.LITTLE_ENDIAN);
    }

    public byte[] encode() {
        ByteBuffer b = ByteBuffer.allocate(8 + payload.length + 4).order(ByteOrder.LITTLE_ENDIAN);
        b.put((byte) SOF1).put((byte) SOF2).put((byte) VERSION).put((byte) type)
                .putShort((short) seq).putShort((short) payload.length).put(payload);
        CRC32 crc = new CRC32();
        crc.update(b.array(), 2, 6 + payload.length);
        b.putInt((int) crc.getValue());
        return b.array();
    }

    public static ByteBuffer buf(int size) {
        return ByteBuffer.allocate(size).order(ByteOrder.LITTLE_ENDIAN);
    }

    /**
     * Byte-at-a-time decoder. After any bad header, length or CRC it re-scans the bytes it had
     * buffered for the next start marker, so a corrupted frame never swallows the good one after it.
     */
    public static final class Decoder {
        private final byte[] buf = new byte[8 + MAX_PAYLOAD + 4];
        private final java.util.ArrayDeque<Frame> ready = new java.util.ArrayDeque<>();
        private int n;
        private int need;
        private long crcErrors;
        private long framingErrors;

        public Decoder() {
            // empty decoder, hunting for a start of frame
        }

        /** Returns a complete, verified frame, or null. */
        public Frame feed(int b) {
            step(b & 0xFF);
            return ready.poll();
        }

        private void step(int b) {
            if (n == 0) {
                if (b == SOF1) {
                    buf[n++] = (byte) b;
                }
                return;
            }
            if (n == 1) {
                if (b == SOF2) {
                    buf[n++] = (byte) b;
                } else {
                    framingErrors++;
                    n = 0;
                    step(b);
                }
                return;
            }
            buf[n++] = (byte) b;
            if (n == 3 && (buf[2] & 0xFF) != VERSION) {
                framingErrors++;
                rescan();
                return;
            }
            if (n == 8) {
                int len = (buf[6] & 0xFF) | ((buf[7] & 0xFF) << 8);
                if (len > MAX_PAYLOAD) {
                    framingErrors++;
                    rescan();
                    return;
                }
                need = 8 + len + 4;
            }
            if (n >= 8 && n == need) {
                int len = need - 12;
                CRC32 crc = new CRC32();
                crc.update(buf, 2, 6 + len);
                int got = (buf[need - 4] & 0xFF) | ((buf[need - 3] & 0xFF) << 8)
                        | ((buf[need - 2] & 0xFF) << 16) | ((buf[need - 1] & 0xFF) << 24);
                if ((int) crc.getValue() != got) {
                    crcErrors++;
                    rescan();
                    return;
                }
                byte[] p = new byte[len];
                System.arraycopy(buf, 8, p, 0, len);
                int seq = (buf[4] & 0xFF) | ((buf[5] & 0xFF) << 8);
                n = 0;
                ready.add(new Frame(buf[3] & 0xFF, seq, p));
            }
        }

        /** Drop the first buffered byte and feed the rest again, looking for a real start marker. */
        private void rescan() {
            byte[] rest = java.util.Arrays.copyOfRange(buf, 1, n);
            n = 0;
            for (byte x : rest) {
                step(x & 0xFF);
            }
        }

        public long crcErrors() {
            return crcErrors;
        }

        public long framingErrors() {
            return framingErrors;
        }
    }
}
