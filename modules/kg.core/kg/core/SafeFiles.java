package kg.core;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;

/**
 * File access that never leaves a root folder, never follows symbolic links,
 * and refuses oversized or non-UTF-8 input.
 */
public final class SafeFiles {
    private SafeFiles() {
    }

    /** Resolve a relative path inside root. Rejects "..", absolute paths and symlinks on the way. */
    public static Path inside(Path root, String relative) throws InputException {
        Path r = root.toAbsolutePath().normalize();
        Path rel = Path.of(relative);
        if (rel.isAbsolute()) {
            throw new InputException("absolute path not allowed: " + relative);
        }
        Path p = r.resolve(rel).normalize();
        if (!p.startsWith(r) || p.equals(r)) {
            throw new InputException("path escapes the workspace: " + relative);
        }
        Path walk = r;
        for (Path part : r.relativize(p)) {
            walk = walk.resolve(part);
            if (Files.isSymbolicLink(walk)) {
                throw new InputException("symbolic link not allowed: " + r.relativize(walk));
            }
        }
        return p;
    }

    /** Read a text file as strict UTF-8 lines with size and line-length limits. */
    public static List<String> readLines(Path p, long maxBytes, int maxLineLength) throws InputException {
        if (Files.isSymbolicLink(p)) {
            throw new InputException("symbolic link not allowed: " + p);
        }
        if (!Files.isRegularFile(p, LinkOption.NOFOLLOW_LINKS)) {
            throw new InputException("not a regular file: " + p);
        }
        byte[] bytes;
        try {
            if (Files.size(p) > maxBytes) {
                throw new InputException("file too large (limit " + maxBytes + " bytes): " + p);
            }
            bytes = Files.readAllBytes(p);
        } catch (IOException e) {
            throw new InputException("cannot read " + p + ": " + e.getMessage());
        }
        String text;
        try {
            text = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException e) {
            throw new InputException("not valid UTF-8: " + p);
        }
        List<String> out = new ArrayList<>();
        int n = 0;
        for (String line : text.split("\n", -1)) {
            n++;
            String l = line.endsWith("\r") ? line.substring(0, line.length() - 1) : line;
            if (l.length() > maxLineLength) {
                throw new InputException(p + ":" + n + ": line longer than " + maxLineLength);
            }
            if (l.indexOf('\0') >= 0) {
                throw new InputException(p + ":" + n + ": NUL character");
            }
            out.add(l);
        }
        if (!out.isEmpty() && out.get(out.size() - 1).isEmpty()) {
            out.remove(out.size() - 1);
        }
        return out;
    }

    /** Write a UTF-8 text file atomically: temp file, then rename. */
    public static void writeAtomic(Path p, String content) throws IOException {
        Path dir = p.toAbsolutePath().getParent();
        Files.createDirectories(dir);
        Path tmp = Files.createTempFile(dir, ".tmp-", ".part");
        try {
            Files.writeString(tmp, content, StandardCharsets.UTF_8);
            try {
                Files.move(tmp, p, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(tmp, p, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(tmp);
        }
    }
}
