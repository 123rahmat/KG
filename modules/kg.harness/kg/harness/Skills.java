package kg.harness;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;
import kg.core.InputException;
import kg.core.SafeFiles;

/**
 * Skills: versioned procedure packs (plain text) that walk an engineer through a common job.
 * A skill lists steps and the kindgleam commands that produce the evidence. It cannot skip a
 * gate, because every step that matters ends in 'kindgleam check' or 'kindgleam verify'.
 */
public final class Skills {
    private Skills() {
    }

    public static List<String> names(Path home) throws IOException {
        List<String> out = new ArrayList<>();
        Path d = home.resolve("skills");
        if (!Files.isDirectory(d)) {
            return out;
        }
        try (Stream<Path> s = Files.list(d)) {
            s.map(p -> p.getFileName().toString()).filter(n -> n.endsWith(".skill")).sorted()
                    .forEach(n -> out.add(n.substring(0, n.length() - 6)));
        }
        return out;
    }

    public static List<String> show(Path home, String name) throws InputException {
        if (!name.matches("[a-z0-9-]{1,40}")) {
            throw new InputException("skill names use lowercase letters, digits and dashes");
        }
        Path p = SafeFiles.inside(home, "skills/" + name + ".skill");
        List<String> lines = SafeFiles.readLines(p, 65536, 300);
        if (lines.isEmpty() || !lines.get(0).startsWith("SKILL ")) {
            throw new InputException(name + ": not a skill file");
        }
        return lines;
    }
}
