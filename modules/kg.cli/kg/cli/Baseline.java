package kg.cli;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.stream.Stream;
import kg.core.Hashing;
import kg.core.SafeFiles;
import kg.verdict.Keys;

/** Signed list of every installed tool file. A run refuses to start if any tool changed. */
final class Baseline {
    private Baseline() {
    }

    private static List<Path> toolFiles(Path home) throws IOException {
        List<Path> out = new ArrayList<>();
        for (String dir : List.of("build/mods", "build/native", "engine/build", "selftest", "firmware-support", "skills")) {
            Path d = home.resolve(dir);
            if (Files.isDirectory(d)) {
                try (Stream<Path> s = Files.list(d)) {
                    s.filter(Files::isRegularFile).sorted().forEach(out::add);
                }
            }
        }
        // the pinned model fingerprints are part of the tools: editing them must be detected
        Path pins = home.resolve("model").resolve("MODEL.txt");
        if (Files.isRegularFile(pins)) {
            out.add(pins);
        }
        return out;
    }

    private static String content(Path home) throws IOException {
        StringBuilder sb = new StringBuilder();
        for (Path p : toolFiles(home)) {
            sb.append(Hashing.sha256(p)).append("  ").append(home.relativize(p)).append('\n');
        }
        return sb.toString();
    }

    /** Where the seal lives: next to the tools in a source checkout, in the user's folder for an installed app. */
    static Path dir(Path home) {
        return kg.core.Places.writable(home);
    }

    static void write(Path home, PrivateKey key) throws IOException, GeneralSecurityException {
        String c = content(home);
        java.nio.file.Files.createDirectories(dir(home));
        SafeFiles.writeAtomic(dir(home).resolve("baseline.txt"), c);
        byte[] sig = Keys.sign(key, c.getBytes(StandardCharsets.UTF_8));
        SafeFiles.writeAtomic(dir(home).resolve("baseline.sig"), Base64.getEncoder().encodeToString(sig) + "\n");
    }

    /** Returns problems; empty means every tool file matches the signed baseline. */
    static List<String> verify(Path home, PublicKey pub) {
        List<String> problems = new ArrayList<>();
        try {
            Path txt = dir(home).resolve("baseline.txt");
            Path sig = dir(home).resolve("baseline.sig");
            if (!Files.exists(txt) || !Files.exists(sig)) {
                problems.add("no signed tool baseline; run 'kindgleam baseline'");
                return problems;
            }
            String stored = Files.readString(txt, StandardCharsets.UTF_8);
            byte[] s = Base64.getDecoder().decode(Files.readString(sig).strip());
            if (!Keys.verify(pub, stored.getBytes(StandardCharsets.UTF_8), s)) {
                problems.add("tool baseline signature invalid");
            }
            String now = content(home);
            if (!now.equals(stored)) {
                List<String> a = List.of(stored.split("\n"));
                for (String line : now.split("\n")) {
                    if (!a.contains(line)) {
                        problems.add("tool file changed or added: " + line.substring(line.indexOf("  ") + 2));
                    }
                }
                if (problems.isEmpty()) {
                    problems.add("tool file removed since baseline");
                }
            }
        } catch (IOException | GeneralSecurityException | IllegalArgumentException e) {
            problems.add("cannot verify tool baseline: " + e.getMessage());
        }
        return problems;
    }
}
