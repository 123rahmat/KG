package kg.rig;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Builds the only flash command Kindgleam will ever issue, after checking it can not touch
 * anything outside the board's application region. There is no code path that unlocks, erases
 * the whole chip, writes option bytes, or changes read protection.
 */
public final class FlashPlan {
    public record Plan(List<String> command, long start, long end) { }

    private FlashPlan() {
    }

    /** Returns problems; empty means the image may be written. */
    public static List<String> check(BoardSpec b, long loadAddress, long imageBytes) {
        List<String> p = new ArrayList<>();
        long end = loadAddress + imageBytes;
        if (imageBytes <= 0) {
            p.add("empty firmware image");
        }
        if (loadAddress < b.flashApp.start() || end > b.flashApp.end()) {
            p.add(String.format(Locale.ROOT, "image 0x%08x..0x%08x falls outside the application region 0x%08x..0x%08x",
                    loadAddress, end, b.flashApp.start(), b.flashApp.end()));
        }
        for (BoardSpec.Region r : b.protectedRegions) {
            if (r.overlaps(loadAddress, end)) {
                p.add(String.format(Locale.ROOT, "image would touch protected region 0x%08x..0x%08x", r.start(), r.end()));
            }
        }
        return p;
    }

    /** "program ... verify" writes, then reads back and compares; then the core is reset. */
    public static Plan build(BoardSpec b, String imagePath, long loadAddress, long imageBytes) {
        if (!check(b, loadAddress, imageBytes).isEmpty()) {
            throw new IllegalArgumentException("flash plan rejected");
        }
        if (!imagePath.matches("[A-Za-z0-9_./-]{1,300}\\.bin") || imagePath.contains("..")) {
            throw new IllegalArgumentException("unsafe image path");
        }
        List<String> cmd = List.of("openocd", "-f", b.ocdInterface, "-f", b.ocdTarget, "-c", "init", "-c",
                String.format(Locale.ROOT, "program %s 0x%08x verify", imagePath, loadAddress), "-c", "reset run",
                "-c", "shutdown");
        return new Plan(cmd, loadAddress, loadAddress + imageBytes);
    }
}
