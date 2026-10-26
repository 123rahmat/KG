package kg.core;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Locale;

/**
 * Each Kindgleam package is built for one operating system and CPU family and says so in
 * platform.txt. Starting a package on a different system is refused with a clear message, so a
 * Windows build is never run on macOS or Linux (or the other way round) with native parts that
 * do not belong there.
 */
public final class Platform {
    private Platform() {
    }

    /** This computer as "os arch", for example "linux x64", "windows arm64", "macos arm64". */
    public static String current() {
        String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
        String o = os.startsWith("windows") ? "windows" : os.contains("mac") || os.contains("darwin") ? "macos"
                : os.contains("linux") ? "linux" : os.replace(' ', '-');
        String a = System.getProperty("os.arch", "").toLowerCase(Locale.ROOT);
        String arch = switch (a) {
            case "amd64", "x86_64", "x64" -> "x64";
            case "aarch64", "arm64" -> "arm64";
            default -> a;
        };
        return o + " " + arch;
    }

    /** Returns null when this package may run here, otherwise the reason it may not. */
    public static String check(Path home) {
        Path f = home.resolve("platform.txt");
        if (!Files.isRegularFile(f)) {
            return null; // a source checkout built on this machine has no platform file
        }
        try {
            List<String> l = SafeFiles.readLines(f, 4096, 200);
            String want = null;
            for (String s : l) {
                if (s.startsWith("PLATFORM ")) {
                    want = s.substring(9).strip();
                }
            }
            if (want == null) {
                return "platform.txt is malformed";
            }
            String here = current();
            if (!want.equals(here)) {
                return "This is the Kindgleam package for " + pretty(want) + ", but this computer is " + pretty(here)
                        + ". Please download and use the " + pretty(here) + " package.";
            }
            return null;
        } catch (InputException e) {
            return "platform.txt could not be read: " + e.getMessage();
        }
    }

    private static String pretty(String p) {
        String[] f = p.split(" ");
        String os = switch (f[0]) {
            case "windows" -> "Windows";
            case "macos" -> "macOS";
            case "linux" -> "Linux";
            default -> f[0];
        };
        String arch = f.length > 1 ? (f[1].equals("x64") ? "Intel/AMD 64-bit" : f[1].equals("arm64") ? "ARM 64-bit" : f[1]) : "";
        return os + (arch.isEmpty() ? "" : " (" + arch + ")");
    }
}
