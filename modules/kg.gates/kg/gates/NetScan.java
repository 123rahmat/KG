package kg.gates;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Air-gap guard for the product itself: scans compiled classes inside module jars and fails
 * if any class refers to networking classes. Only NetworkInterface is allowed, because the
 * air-gap self-check uses it to list interfaces.
 */
public final class NetScan {
    /* Written with dots so this scanner's own class file does not contain the slash form it searches for. */
    private static final String[] FORBIDDEN_DOTTED = {
        "java.net.Socket", "java.net.ServerSocket", "java.net.URL", "java.net.URI", "java.net.http.",
        "java.net.DatagramSocket", "java.net.InetSocketAddress", "java.nio.channels.SocketChannel",
        "java.nio.channels.ServerSocketChannel", "java.nio.channels.DatagramChannel", "javax.net.",
        "java.rmi.", "javax.naming."
    };

    private NetScan() {
    }

    public static List<String> scanJars(List<Path> jars) throws IOException {
        List<String> out = new ArrayList<>();
        for (Path jar : jars) {
            try (ZipFile z = new ZipFile(jar.toFile())) {
                Enumeration<? extends ZipEntry> en = z.entries();
                while (en.hasMoreElements()) {
                    ZipEntry e = en.nextElement();
                    if (!e.getName().endsWith(".class")) {
                        continue;
                    }
                    byte[] data;
                    try (InputStream in = z.getInputStream(e)) {
                        data = in.readNBytes(4 * 1024 * 1024);
                    }
                    String s = new String(data, StandardCharsets.ISO_8859_1);
                    for (String dotted : FORBIDDEN_DOTTED) {
                        String f = dotted.replace('.', '/');
                        if (refers(s, f)) {
                            out.add(jar.getFileName() + "!" + e.getName() + " refers to " + f);
                        }
                    }
                }
            }
        }
        if (jars.isEmpty()) {
            out.add("no product jars found to scan");
        }
        return out;
    }

    /** True if s names class f exactly (or anything under package prefix f ending in '/'). */
    private static boolean refers(String s, String f) {
        int i = s.indexOf(f);
        while (i >= 0) {
            int end = i + f.length();
            if (f.endsWith("/") || end >= s.length()) {
                return true;
            }
            char c = s.charAt(end);
            if (!Character.isLetterOrDigit(c) && c != '_') {
                return true; /* exact class name, or inner class via '$' */
            }
            i = s.indexOf(f, i + 1);
        }
        return false;
    }

    public static List<Path> jarsIn(Path dir) throws IOException {
        List<Path> out = new ArrayList<>();
        try (var s = Files.list(dir)) {
            s.filter(p -> p.toString().endsWith(".jar")).sorted().forEach(out::add);
        }
        return out;
    }
}
