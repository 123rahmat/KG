package kg.rig;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * Hardware detection. Step 1: USB scan for known debug probes and USB-serial chips.
 * Step 2: chip identity read through OpenOCD (device id and unique id registers).
 * Step 3 (HELLO over the link) is in PilRunner.
 */
public final class Detect {
    /** Known debug probes and USB-serial bridges, by USB vendor:product id. */
    public static final Map<String, String> KNOWN = Map.ofEntries(
            Map.entry("0483:3748", "ST-LINK/V2"), Map.entry("0483:374b", "ST-LINK/V2-1"),
            Map.entry("0483:374e", "STLINK-V3"), Map.entry("0483:374f", "STLINK-V3"),
            Map.entry("0483:3752", "ST-LINK/V2-1"), Map.entry("0483:3753", "STLINK-V3"),
            Map.entry("0483:3754", "STLINK-V3"), Map.entry("1366:0101", "SEGGER J-Link"),
            Map.entry("1366:0105", "SEGGER J-Link"), Map.entry("1366:1015", "SEGGER J-Link OB"),
            Map.entry("1366:1020", "SEGGER J-Link"), Map.entry("1366:1024", "SEGGER J-Link"),
            Map.entry("2e8a:000c", "Raspberry Pi Debug Probe (CMSIS-DAP)"), Map.entry("0d28:0204", "Arm DAPLink (CMSIS-DAP)"),
            Map.entry("c251:f001", "Keil ULINK"), Map.entry("1fc9:0090", "NXP LPC-Link2 (CMSIS-DAP)"),
            Map.entry("0403:6001", "FTDI FT232R USB-serial"), Map.entry("0403:6010", "FTDI FT2232 (serial/JTAG)"),
            Map.entry("0403:6014", "FTDI FT232H (serial/JTAG)"), Map.entry("0403:6015", "FTDI FT-X USB-serial"),
            Map.entry("10c4:ea60", "Silicon Labs CP210x USB-serial"), Map.entry("1a86:7523", "WCH CH340 USB-serial"),
            Map.entry("067b:2303", "Prolific PL2303 USB-serial"), Map.entry("303a:1001", "Espressif USB-JTAG/serial"));

    public record UsbDevice(String id, String name, String serial, String product) {
        public String describe() {
            return name + " [" + id + "]" + (serial.isEmpty() ? "" : " serial " + serial);
        }
    }

    private static final Pattern MDW = Pattern.compile("0x([0-9a-fA-F]{8}):\\s+([0-9a-fA-F]{8})((?:\\s+[0-9a-fA-F]{8})*)");

    private Detect() {
    }

    /** Linux: reads /sys/bus/usb/devices. Other systems are handled by the platform module (returns empty). */
    public static List<UsbDevice> scanUsb() throws IOException {
        List<UsbDevice> out = new ArrayList<>();
        Path root = Path.of("/sys/bus/usb/devices");
        if (!Files.isDirectory(root)) {
            return out;
        }
        try (Stream<Path> s = Files.list(root)) {
            for (Path d : s.sorted().toList()) {
                String vid = read(d.resolve("idVendor"));
                String pid = read(d.resolve("idProduct"));
                if (vid.isEmpty() || pid.isEmpty()) {
                    continue;
                }
                String id = (vid + ":" + pid).toLowerCase(Locale.ROOT);
                String name = KNOWN.get(id);
                if (name != null) {
                    out.add(new UsbDevice(id, name, read(d.resolve("serial")), read(d.resolve("product"))));
                }
            }
        }
        return out;
    }

    private static String read(Path p) {
        try {
            if (!Files.isRegularFile(p) || Files.size(p) > 256) {
                return "";
            }
            return Files.readString(p).strip().replaceAll("[^A-Za-z0-9 ._:/-]", "?");
        } catch (IOException e) {
            return "";
        }
    }

    /**
     * OpenOCD command that only READS identity registers. No write, erase or option-byte command
     * is ever built here. idAddr/uidAddr come from the chip family table, never from user input.
     */
    public static List<String> openOcdReadIdentity(BoardSpec b, long idAddr, long uidAddr) {
        return List.of("openocd", "-f", b.ocdInterface, "-f", b.ocdTarget, "-c", "init", "-c",
                String.format(Locale.ROOT, "mdw 0x%08x 1", idAddr), "-c",
                String.format(Locale.ROOT, "mdw 0x%08x 3", uidAddr), "-c", "shutdown");
    }

    /** Parses "0xe0042000: 10076413" lines from OpenOCD output into address -> words. */
    public static Map<Long, long[]> parseMdw(List<String> lines) {
        Map<Long, long[]> m = new java.util.LinkedHashMap<>();
        for (String l : lines) {
            Matcher x = MDW.matcher(l.strip());
            if (x.matches()) {
                List<Long> words = new ArrayList<>();
                words.add(Long.parseLong(x.group(2), 16));
                for (String w : x.group(3).strip().split("\\s+")) {
                    if (!w.isEmpty()) {
                        words.add(Long.parseLong(w, 16));
                    }
                }
                m.put(Long.parseLong(x.group(1), 16), words.stream().mapToLong(Long::longValue).toArray());
            }
        }
        return m;
    }

    /** STM32 family: device id is the low 12 bits of DBGMCU_IDCODE. */
    public static long stm32DeviceId(long idcode) {
        return idcode & 0xFFF;
    }
}
