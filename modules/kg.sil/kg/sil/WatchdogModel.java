package kg.sil;

/**
 * SIL model of the independent, windowed hardware watchdog (blueprint section 10).
 * A kick is accepted only inside the window and only with a new progress token whose
 * low three bits prove the read, control and output tasks all finished.
 */
public final class WatchdogModel {
    private final int winMin;
    private final int winMax;
    private int sinceKick;
    private int lastToken;
    private boolean tripped;

    public WatchdogModel(int winMin, int winMax) {
        this.winMin = winMin;
        this.winMax = winMax;
    }

    /** Called by the independent timer every tick. */
    public void tick() {
        if (tripped) {
            return;
        }
        sinceKick++;
        if (sinceKick > winMax) {
            tripped = true;
        }
    }

    public void kick(int token) {
        if (tripped) {
            return;
        }
        if (sinceKick < winMin || token == lastToken || (token & 7) != 7) {
            tripped = true;
            return;
        }
        lastToken = token;
        sinceKick = 0;
    }

    public boolean tripped() {
        return tripped;
    }
}
