package kg.rig;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import kg.core.InputException;
import kg.core.SafeFiles;

/**
 * What the project expects to be connected (board.cfg). Detection must match every line
 * before anything is flashed or run on hardware.
 *
 *   BOARD <name> <revision>
 *   CHIP_ID <hex>                      expected device id read from the chip
 *   TARGET virtual | serial
 *   VIRTUAL_IDENTITY <name> <rev> <hex> identity the simulated board reports (TARGET virtual)
 *   PROBE <vid>:<pid>                  debug probe USB id (TARGET serial)
 *   PORT <device>                      serial device (TARGET serial)
 *   BAUD <rate>
 *   LINK_TIMEOUT_MS <ms>
 *   LINK_RETRIES <n>
 *   VIRTUAL_LINK_FAULTS_PPM <n>       corrupt n bytes per million both ways to prove recovery
 *   OPENOCD_INTERFACE <file.cfg>  OPENOCD_TARGET <file.cfg>
 *   FLASH_APP <start> <end>            the only region firmware may be written to
 *   FLASH_PROTECTED <start> <end>      never touched (bootloader, option bytes, OTP); repeatable
 */
public final class BoardSpec {
    private static final Pattern NAME = Pattern.compile("[A-Za-z0-9._-]{1,40}");
    private static final Pattern USBID = Pattern.compile("[0-9a-f]{4}:[0-9a-f]{4}");
    private static final Pattern PORT = Pattern.compile("/dev/(tty(ACM|USB)[0-9]{1,3}|cu\\.[A-Za-z0-9._-]{1,60})|COM[0-9]{1,3}");
    private static final Pattern OCD = Pattern.compile("[a-z0-9_./-]{1,80}\\.cfg");

    public record Region(long start, long end) {
        public boolean overlaps(long s, long e) {
            return s < end && start < e;
        }
    }

    public String board;
    public String revision;
    public long chipId;
    public boolean virtual;
    public String virtualName;
    public String virtualRev;
    public long virtualChip;
    public String probe;
    public String port;
    public int baud = 115200;
    public int timeoutMs = 200;
    public int retries = 5;
    public int virtualFaultPpm;
    public String ocdInterface;
    public String ocdTarget;
    public Region flashApp;
    public final List<Region> protectedRegions = new ArrayList<>();

    private BoardSpec() {
    }

    public static BoardSpec load(Path p) throws InputException {
        BoardSpec b = new BoardSpec();
        String target = null;
        int ln = 0;
        for (String raw : SafeFiles.readLines(p, 8192, 200)) {
            ln++;
            String l = raw.strip();
            if (l.isEmpty() || l.startsWith("#")) {
                continue;
            }
            String[] t = l.split("\\s+");
            String where = "board.cfg:" + ln + ": ";
            try {
                switch (t[0]) {
                    case "BOARD" -> {
                        n(t, 3, where);
                        b.board = name(t[1], where);
                        b.revision = name(t[2], where);
                    }
                    case "CHIP_ID" -> {
                        n(t, 2, where);
                        b.chipId = hex(t[1]);
                    }
                    case "TARGET" -> {
                        n(t, 2, where);
                        target = t[1];
                    }
                    case "VIRTUAL_IDENTITY" -> {
                        n(t, 4, where);
                        b.virtualName = name(t[1], where);
                        b.virtualRev = name(t[2], where);
                        b.virtualChip = hex(t[3]);
                    }
                    case "PROBE" -> {
                        n(t, 2, where);
                        if (!USBID.matcher(t[1]).matches()) {
                            throw new InputException(where + "PROBE must be vid:pid in lowercase hex");
                        }
                        b.probe = t[1];
                    }
                    case "PORT" -> {
                        n(t, 2, where);
                        if (!PORT.matcher(t[1]).matches()) {
                            throw new InputException(where + "PORT must be a serial device such as /dev/ttyACM0 or COM3");
                        }
                        b.port = t[1];
                    }
                    case "BAUD" -> {
                        n(t, 2, where);
                        b.baud = Integer.parseInt(t[1]);
                        if (b.baud < 9600 || b.baud > 4_000_000) {
                            throw new InputException(where + "BAUD out of range");
                        }
                    }
                    case "LINK_TIMEOUT_MS" -> {
                        n(t, 2, where);
                        b.timeoutMs = Integer.parseInt(t[1]);
                        if (b.timeoutMs < 1 || b.timeoutMs > 10_000) {
                            throw new InputException(where + "LINK_TIMEOUT_MS out of range");
                        }
                    }
                    case "LINK_RETRIES" -> {
                        n(t, 2, where);
                        b.retries = Integer.parseInt(t[1]);
                        if (b.retries < 0 || b.retries > 20) {
                            throw new InputException(where + "LINK_RETRIES out of range");
                        }
                    }
                    case "VIRTUAL_LINK_FAULTS_PPM" -> {
                        n(t, 2, where);
                        b.virtualFaultPpm = Integer.parseInt(t[1]);
                        if (b.virtualFaultPpm < 0 || b.virtualFaultPpm > 50_000) {
                            throw new InputException(where + "VIRTUAL_LINK_FAULTS_PPM out of range 0..50000");
                        }
                    }
                    case "OPENOCD_INTERFACE" -> {
                        n(t, 2, where);
                        b.ocdInterface = ocd(t[1], where);
                    }
                    case "OPENOCD_TARGET" -> {
                        n(t, 2, where);
                        b.ocdTarget = ocd(t[1], where);
                    }
                    case "FLASH_APP" -> {
                        n(t, 3, where);
                        b.flashApp = region(t, where);
                    }
                    case "FLASH_PROTECTED" -> {
                        n(t, 3, where);
                        b.protectedRegions.add(region(t, where));
                    }
                    default -> throw new InputException(where + "unknown key " + t[0]);
                }
            } catch (NumberFormatException e) {
                throw new InputException(where + "bad number");
            }
        }
        if (b.board == null || b.chipId == 0 || target == null || b.flashApp == null) {
            throw new InputException("board.cfg: needs BOARD, CHIP_ID, TARGET and FLASH_APP");
        }
        if (target.equals("virtual")) {
            b.virtual = true;
            if (b.virtualName == null) {
                throw new InputException("board.cfg: TARGET virtual needs VIRTUAL_IDENTITY");
            }
        } else if (target.equals("serial")) {
            if (b.probe == null || b.port == null || b.ocdInterface == null || b.ocdTarget == null) {
                throw new InputException("board.cfg: TARGET serial needs PROBE, PORT, OPENOCD_INTERFACE, OPENOCD_TARGET");
            }
        } else {
            throw new InputException("board.cfg: TARGET must be virtual or serial");
        }
        for (Region r : b.protectedRegions) {
            if (b.flashApp.overlaps(r.start(), r.end())) {
                throw new InputException("board.cfg: FLASH_APP overlaps a FLASH_PROTECTED region");
            }
        }
        return b;
    }

    private static void n(String[] t, int k, String where) throws InputException {
        if (t.length != k) {
            throw new InputException(where + t[0] + " expects " + (k - 1) + " value(s)");
        }
    }

    private static String name(String s, String where) throws InputException {
        if (!NAME.matcher(s).matches()) {
            throw new InputException(where + "invalid name '" + s + "'");
        }
        return s;
    }

    private static String ocd(String s, String where) throws InputException {
        if (!OCD.matcher(s).matches() || s.contains("..")) {
            throw new InputException(where + "invalid OpenOCD config name");
        }
        return s;
    }

    static long hex(String s) {
        String h = s.startsWith("0x") || s.startsWith("0X") ? s.substring(2) : s;
        if (h.isEmpty() || h.length() > 8) {
            throw new NumberFormatException("bad hex");
        }
        return Long.parseLong(h, 16);
    }

    private static Region region(String[] t, String where) throws InputException {
        long s = hex(t[1]);
        long e = hex(t[2]);
        if (e <= s) {
            throw new InputException(where + "region end must be above start");
        }
        return new Region(s, e);
    }
}
