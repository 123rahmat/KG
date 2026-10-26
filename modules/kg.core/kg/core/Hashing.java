package kg.core;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/** SHA-256 from the Java runtime. No outside library. */
public final class Hashing {
    private Hashing() {
    }

    private static MessageDigest digest() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 missing from Java runtime", e);
        }
    }

    public static String sha256(byte[] data) {
        return HexFormat.of().formatHex(digest().digest(data));
    }

    public static String sha256(String text) {
        return sha256(text.getBytes(StandardCharsets.UTF_8));
    }

    public static String sha256(Path p) throws IOException {
        if (Files.isSymbolicLink(p)) {
            throw new IOException("refusing to hash a symbolic link: " + p);
        }
        MessageDigest md = digest();
        byte[] buf = new byte[65536];
        try (InputStream in = Files.newInputStream(p, LinkOption.NOFOLLOW_LINKS)) {
            int n;
            while ((n = in.read(buf)) > 0) {
                md.update(buf, 0, n);
            }
        }
        return HexFormat.of().formatHex(md.digest());
    }
}
