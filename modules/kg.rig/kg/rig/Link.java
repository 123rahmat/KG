package kg.rig;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.time.Duration;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * PC side of the link. Every request carries a sequence number and must be answered within
 * the timeout; it is retried a limited number of times, then the link is declared lost.
 * The board answers a repeated sequence number by resending its last reply, never by acting
 * twice, so a retry can never make the firmware step twice.
 */
public final class Link implements AutoCloseable {
    public static final class LinkLost extends Exception {
        private static final long serialVersionUID = 1L;

        LinkLost(String m) {
            super(m);
        }
    }

    public record Stats(long sent, long received, long retries, long timeouts, long crcErrors,
                        long framingErrors, long staleFrames, long maxLatencyMicros) {
        public String summary() {
            return sent + " requests, " + retries + " retries, " + crcErrors + " corrupted frames detected, "
                    + staleFrames + " stale replies ignored, worst reply " + maxLatencyMicros + " us";
        }
    }

    private final InputStream in;
    private final OutputStream out;
    private final long timeoutNanos;
    private final int retries;
    private final Frame.Decoder decoder = new Frame.Decoder();
    private final BlockingQueue<Frame> queue = new LinkedBlockingQueue<>(1024);
    private final Thread reader;
    private volatile boolean closed;
    private volatile String readError;
    private int seq;
    private long sent;
    private long received;
    private long retried;
    private long timeouts;
    private long stale;
    private long maxLatency;

    public Link(InputStream in, OutputStream out, Duration timeout, int retries) {
        this.in = in;
        this.out = out;
        this.timeoutNanos = timeout.toNanos();
        this.retries = retries;
        this.reader = new Thread(this::readLoop, "kg-link-reader");
        this.reader.setDaemon(true);
        this.reader.start();
    }

    private void readLoop() {
        try {
            int b;
            while (!closed && (b = in.read()) >= 0) {
                Frame f;
                synchronized (decoder) {
                    f = decoder.feed(b);
                }
                if (f != null && !queue.offer(f)) {
                    readError = "receive queue overflow";
                    return;
                }
            }
            if (!closed) {
                readError = "board closed the connection";
            }
        } catch (IOException e) {
            if (!closed) {
                readError = "read error: " + e.getMessage();
            }
        }
    }

    /** Sends one request and waits for its reply of the expected type, using the normal timeout. */
    public Frame request(int type, byte[] payload, int expect) throws LinkLost {
        return request(type, payload, expect, timeoutNanos);
    }

    /** Same, with a longer timeout for the start-up handshake while the target boots. */
    public Frame requestSlow(int type, byte[] payload, int expect, Duration timeout) throws LinkLost {
        return request(type, payload, expect, timeout.toNanos());
    }

    private synchronized Frame request(int type, byte[] payload, int expect, long timeoutNanos) throws LinkLost {
        int mySeq = seq;
        seq = (seq + 1) & 0xFFFF;
        byte[] wire = new Frame(type, mySeq, payload).encode();
        for (int attempt = 0; attempt <= retries; attempt++) {
            if (attempt > 0) {
                retried++;
            }
            long t0 = System.nanoTime();
            try {
                out.write(wire);
                out.flush();
            } catch (IOException e) {
                throw new LinkLost("write failed: " + e.getMessage());
            }
            sent++;
            long deadline = t0 + timeoutNanos;
            while (true) {
                long left = deadline - System.nanoTime();
                if (left <= 0) {
                    timeouts++;
                    break;
                }
                Frame f;
                try {
                    f = queue.poll(left, TimeUnit.NANOSECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new LinkLost("interrupted");
                }
                if (f == null) {
                    if (readError != null) {
                        throw new LinkLost(readError);
                    }
                    continue;
                }
                if (f.seq() != mySeq) {
                    stale++;
                    continue;
                }
                received++;
                maxLatency = Math.max(maxLatency, (System.nanoTime() - t0) / 1000);
                if (f.type() == Frame.NAK) {
                    throw new LinkLost("board refused request type " + type + " (NAK code "
                            + (f.payload().length > 0 ? f.payload()[0] : -1) + ")");
                }
                if (f.type() != expect) {
                    throw new LinkLost("unexpected reply type " + f.type() + " to request " + type);
                }
                return f;
            }
            if (readError != null) {
                throw new LinkLost(readError);
            }
        }
        throw new LinkLost("no valid reply after " + (retries + 1) + " attempts (request type " + type + ")");
    }

    public Stats stats() {
        synchronized (decoder) {
            return new Stats(sent, received, retried, timeouts, decoder.crcErrors(), decoder.framingErrors(),
                    stale, maxLatency);
        }
    }

    @Override
    public void close() {
        closed = true;
        try {
            out.close();
        } catch (IOException e) {
            // closing anyway
        }
    }
}
