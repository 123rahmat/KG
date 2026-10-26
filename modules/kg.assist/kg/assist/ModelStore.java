package kg.assist;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import kg.core.Hashing;
import kg.core.InputException;
import kg.core.SafeFiles;

/**
 * The single assistant model. It lives in Kindgleam's own program folder (<home>/model), next to
 * the application, so installing the app installs it and uninstalling the app removes it. The
 * user's own folder (~/.kindgleam) never holds a model.
 *
 * MODEL.txt pins the published SHA-256 fingerprints (it is covered by the tool seal, so it cannot be
 * edited unnoticed). The engine hashes the exact bytes it loads on every start and refuses to run
 * unless they match one of them; nothing else is trusted.
 */
public final class ModelStore {
    /** ready: a model file is in place. sha256: the accepted fingerprints, comma separated, for the engine. */
    public record Status(boolean ready, Path file, String sha256, long size, String message) { }

    private final Path dir;

    public ModelStore(Path home) {
        this.dir = home.resolve("model");
    }

    public Path dir() {
        return dir;
    }

    /** Engine log: a temporary file, not kept in the user's folder. */
    public Path logFile() {
        return Path.of(System.getProperty("java.io.tmpdir"), "kindgleam-engine.log");
    }

    Map<String, String> manifest() throws InputException {
        Map<String, String> m = new LinkedHashMap<>();
        for (String l : SafeFiles.readLines(dir.resolve("MODEL.txt"), 8192, 500)) {
            if (l.isBlank() || l.startsWith("#") || l.startsWith("ALSO ")) {
                continue;
            }
            int sp = l.indexOf(' ');
            if (sp > 0) {
                m.put(l.substring(0, sp), l.substring(sp + 1).strip());
            }
        }
        for (String k : List.of("FILE", "SHA256")) {
            if (!m.containsKey(k)) {
                throw new InputException("model/MODEL.txt is missing " + k);
            }
        }
        if (!m.get("FILE").matches("[A-Za-z0-9._-]{1,100}\\.gguf") || !m.get("SHA256").matches("[0-9a-f]{64}")) {
            throw new InputException("model/MODEL.txt has an invalid FILE or SHA256 line");
        }
        return m;
    }

    /** Every fingerprint MODEL.txt accepts: the main SHA256 line plus any ALSO lines. */
    public Set<String> acceptedShas() throws InputException {
        Set<String> out = new LinkedHashSet<>();
        out.add(manifest().get("SHA256"));
        for (String l : SafeFiles.readLines(dir.resolve("MODEL.txt"), 8192, 500)) {
            if (l.startsWith("ALSO ")) {
                String[] f = l.split("\\s+");
                if (f.length < 2 || !f[1].matches("[0-9a-f]{64}")) {
                    throw new InputException("model/MODEL.txt has an invalid ALSO line");
                }
                out.add(f[1]);
            }
        }
        return out;
    }

    public Path file() throws InputException {
        return dir.resolve(manifest().get("FILE"));
    }

    /**
     * Copies a downloaded model file into Kindgleam's program folder, unchanged, after checking it
     * against the pinned fingerprints. Needs write access to that folder (administrator rights when
     * Kindgleam is installed system-wide); the installers normally ship the model already inside.
     */
    public String install(Path source) throws IOException, InputException {
        if (!Files.isRegularFile(source) || Files.isSymbolicLink(source)) {
            throw new InputException("not a regular file: " + source);
        }
        String sha = Hashing.sha256(source);
        if (!acceptedShas().contains(sha)) {
            throw new InputException("this file's SHA-256 is " + sha + " but Kindgleam only accepts the published model files "
                    + "listed in model/MODEL.txt (" + manifest().getOrDefault("NAME", "") + "). Nothing was installed.");
        }
        Path target = file();
        if (Files.exists(target) && Files.isSameFile(source, target)) {
            return sha;
        }
        if (!Files.isWritable(dir)) {
            throw new InputException("Kindgleam's program folder " + dir + " is read-only for this user. Run the command as "
                    + "administrator, or use an installer that includes the model.");
        }
        Path tmp = dir.resolve(target.getFileName() + ".part");
        Files.copy(source, tmp, StandardCopyOption.REPLACE_EXISTING);
        if (!Hashing.sha256(tmp).equals(sha)) {
            Files.deleteIfExists(tmp);
            throw new IOException("copy was damaged; nothing was installed");
        }
        Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        return sha;
    }

    /** Reads the whole file and confirms it is a published model (the engine does the same on load). */
    public String verifyFully() throws IOException, InputException {
        Path f = file();
        if (!Files.isRegularFile(f)) {
            throw new InputException("no model file at " + f);
        }
        String sha = Hashing.sha256(f);
        if (!acceptedShas().contains(sha)) {
            throw new InputException("the model file has been changed (SHA-256 " + sha + "); reinstall Kindgleam or the model");
        }
        return sha;
    }

    public Status status() {
        Map<String, String> m;
        Set<String> ok;
        try {
            m = manifest();
            ok = acceptedShas();
        } catch (InputException e) {
            return new Status(false, null, null, 0, e.getMessage());
        }
        Path file = dir.resolve(m.get("FILE"));
        if (!Files.isRegularFile(file)) {
            Path tools = dir.getParent().resolve("tools");
            return new Status(false, file, null, 0, "This installation has no assistant model yet. The easiest way is an installer "
                    + "that includes it. Otherwise, on a computer with internet, run " + tools.resolve("get-model.cmd")
                    + " (Windows) or " + tools.resolve("get-model.sh") + " (macOS, Linux) as administrator: it downloads "
                    + m.getOrDefault("NAME", "the model") + " once, checks it and puts it in " + dir
                    + ". Uninstalling Kindgleam removes it again.");
        }
        try {
            long size = Files.size(file);
            return new Status(true, file, String.join(",", ok), size, (size >> 20) + " MB in " + dir
                    + "; checked against the published fingerprint every time it loads");
        } catch (IOException e) {
            return new Status(false, file, null, 0, "model file could not be read: " + e.getMessage());
        }
    }
}
