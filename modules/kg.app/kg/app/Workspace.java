package kg.app;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;
import kg.core.Places;
import kg.core.SafeFiles;

/**
 * The user's Kindgleam folder, ~/.kindgleam, found or created on every start (like ~/.vscode).
 * A reinstalled or updated app finds the existing key, settings and every project in
 * ~/.kindgleam/projects; a new computer gets a fresh folder.
 */
final class Workspace {
    private Workspace() {
    }

    /** What start-up found. */
    record Found(boolean existed, List<Path> projects, List<Path> newlyListed) { }

    static Path root() {
        return Places.state();
    }

    static Path projects() {
        return root().resolve("projects");
    }

    /** Finds or creates ~/.kindgleam and lists the projects in it; adds unlisted ones to the sidebar. */
    static Found open(AppSettings settings) {
        boolean existed = Files.isDirectory(root());
        try {
            Files.createDirectories(projects());
            Path readme = root().resolve("README.txt");
            if (!Files.exists(readme)) {
                SafeFiles.writeAtomic(readme, """
                        This folder belongs to Kindgleam. It is kept when Kindgleam is updated or reinstalled.

                        projects/       your projects, one folder each (firmware, tests, runs, signed evidence, history)
                        keys/           this computer's signing key; keep it private and back it up
                        settings.cfg    app preferences
                        baseline.*      the seal of the installed Kindgleam tools

                        To move to a new computer, copy the projects you need (and, if you want the same signing
                        identity, the keys folder) into the same place on the new computer.
                        """);
            }
        } catch (IOException e) {
            return new Found(existed, List.of(), List.of());
        }
        List<Path> found = new ArrayList<>();
        try (Stream<Path> s = Files.list(projects())) {
            for (Path p : s.sorted().toList()) {
                if (Files.isDirectory(p) && !Files.isSymbolicLink(p)
                        && (Files.isRegularFile(p.resolve("interface.cfg")) || Files.isRegularFile(p.resolve("profile.cfg")))) {
                    found.add(p.toAbsolutePath().normalize());
                }
            }
        } catch (IOException e) {
            // no projects yet
        }
        List<Path> added = new ArrayList<>();
        for (Path p : found) {
            if (!settings.recent.contains(p.toString())) {
                settings.recent.add(p.toString());
                added.add(p);
            }
        }
        if (!added.isEmpty()) {
            settings.save();
        }
        return new Found(existed, found, added);
    }
}
