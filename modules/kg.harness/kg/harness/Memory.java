package kg.harness;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import kg.core.Hashing;
import kg.core.InputException;
import kg.core.SafeFiles;

/**
 * Project memory: append-only, hash-chained logs. Every entry has a date and a source.
 * Memory informs people; it never changes a requirement, a limit or a verdict.
 *
 *   memory/decisions.log    design decisions and who/what they came from
 *   memory/facts.log        hardware facts: errata, pin quirks, measured values
 *   memory/runs.log         one line per verification run (written by the Memory keeper agent)
 *   memory/review_queue.log items a person should look at (weak tests, reviewed exceptions)
 *
 * Line format:  M1 <hash> <prev> <yyyy-mm-dd> <source> | <text>
 */
public final class Memory {
    public static final List<String> LOGS = List.of("decisions", "facts", "runs", "review_queue");
    private static final String GENESIS = "0".repeat(64);

    private Memory() {
    }

    private static Path log(Path project, String name) throws InputException {
        if (!LOGS.contains(name)) {
            throw new InputException("unknown memory log '" + name + "' (use " + String.join(", ", LOGS) + ")");
        }
        return project.resolve("memory").resolve(name + ".log");
    }

    public static String add(Path project, String name, String source, String text) throws InputException, IOException {
        String s = source.strip();
        String t = text.strip();
        if (!s.matches("[A-Za-z0-9._:/@#-]{1,80}")) {
            throw new InputException("source must be a short reference such as datasheet-RM0090-p112, run-0007 or a name");
        }
        if (t.isEmpty() || t.length() > 500 || t.chars().anyMatch(c -> c < 0x20)) {
            throw new InputException("memory text must be one line of 1..500 printable characters");
        }
        Path p = log(project, name);
        Files.createDirectories(p.getParent());
        String prev = GENESIS;
        if (Files.exists(p)) {
            List<String> lines = SafeFiles.readLines(p, 16L * 1024 * 1024, 1000);
            if (!lines.isEmpty()) {
                prev = lines.get(lines.size() - 1).split(" ")[1];
            }
        }
        String date = LocalDate.now(ZoneOffset.UTC).toString();
        String body = prev + " " + date + " " + s + " | " + t;
        String h = Hashing.sha256(body);
        Files.writeString(p, "M1 " + h + " " + body + "\n", StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.APPEND, StandardOpenOption.SYNC);
        return h;
    }

    /** Problems in one log's chain; empty means intact. */
    public static List<String> verify(Path project, String name) throws InputException {
        List<String> out = new ArrayList<>();
        Path p = log(project, name);
        if (!Files.exists(p)) {
            return out;
        }
        String prev = GENESIS;
        int ln = 0;
        for (String l : SafeFiles.readLines(p, 16L * 1024 * 1024, 1000)) {
            ln++;
            String[] f = l.split(" ", 3);
            if (f.length != 3 || !f[0].equals("M1")) {
                out.add(name + ".log line " + ln + ": malformed");
                return out;
            }
            if (!f[2].startsWith(prev + " ")) {
                out.add(name + ".log line " + ln + ": chain broken (an earlier entry was removed or changed)");
            }
            if (!Hashing.sha256(f[2]).equals(f[1])) {
                out.add(name + ".log line " + ln + ": entry altered");
            }
            prev = f[1];
        }
        return out;
    }

    /** Human-readable entries: date, source, text. */
    public static List<String> list(Path project, String name) throws InputException {
        List<String> out = new ArrayList<>();
        Path p = log(project, name);
        if (!Files.exists(p)) {
            return out;
        }
        for (String l : SafeFiles.readLines(p, 16L * 1024 * 1024, 1000)) {
            String[] f = l.split(" ", 5);
            if (f.length == 5) {
                out.add(f[3] + "  [" + f[4].substring(0, f[4].indexOf(" | ")) + "]  " + f[4].substring(f[4].indexOf(" | ") + 3));
            }
        }
        return out;
    }
}
