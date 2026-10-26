package kg.verdict;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.GeneralSecurityException;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import kg.core.Hashing;
import kg.core.InputException;
import kg.core.SafeFiles;

/**
 * Append-only, hash-chained, Ed25519-signed evidence ledger. One line per run:
 *   E1 <entry_hash> <prev_hash> <run> <verdict> <platform> <n> <path>=<sha256> ... SIG <base64>
 * entry_hash = SHA-256 of everything from <prev_hash> up to the last file; the signature covers entry_hash.
 */
public final class Ledger {
    public static final String GENESIS = "0".repeat(64);
    private static final Pattern HEX = Pattern.compile("[0-9a-f]{64}");
    private static final Pattern SAFE_TOKEN = Pattern.compile("[A-Za-z0-9._/+:-]+");

    private Ledger() {
    }

    /** Last entry hash, or the genesis value for an empty or missing ledger. */
    public static String head(Path ledger) throws InputException {
        if (!Files.exists(ledger)) {
            return GENESIS;
        }
        List<String> lines = SafeFiles.readLines(ledger, 64L * 1024 * 1024, 200_000);
        if (lines.isEmpty()) {
            return GENESIS;
        }
        String[] f = lines.get(lines.size() - 1).split(" ");
        if (f.length < 2 || !HEX.matcher(f[1]).matches()) {
            throw new InputException("ledger: last line is not a valid entry");
        }
        return f[1];
    }

    /**
     * Appends one entry. File paths are stored relative to base and must be safe tokens.
     * Returns the new entry hash.
     */
    public static String append(Path ledger, Path base, String run, String verdict, String platform,
                                Map<String, Path> files, PrivateKey key)
            throws IOException, InputException, GeneralSecurityException {
        for (String t : List.of(run, verdict, platform)) {
            if (!SAFE_TOKEN.matcher(t).matches()) {
                throw new InputException("ledger: unsafe token '" + t + "'");
            }
        }
        StringBuilder payload = new StringBuilder();
        payload.append(head(ledger)).append(' ').append(run).append(' ').append(verdict).append(' ')
                .append(platform).append(' ').append(files.size());
        for (Map.Entry<String, Path> e : files.entrySet()) {
            if (!SAFE_TOKEN.matcher(e.getKey()).matches()) {
                throw new InputException("ledger: unsafe path '" + e.getKey() + "'");
            }
            payload.append(' ').append(e.getKey()).append('=').append(Hashing.sha256(e.getValue()));
        }
        String entryHash = Hashing.sha256(payload.toString());
        String sig = Base64.getEncoder().encodeToString(
                Keys.sign(key, entryHash.getBytes(StandardCharsets.US_ASCII)));
        String line = "E1 " + entryHash + " " + payload + " SIG " + sig + "\n";
        Files.writeString(ledger, line, StandardCharsets.UTF_8, StandardOpenOption.CREATE,
                StandardOpenOption.APPEND, StandardOpenOption.SYNC);
        return entryHash;
    }

    /** Verifies chain, hashes, signatures and every referenced file. Returns problems (empty = intact). */
    public static List<String> verify(Path ledger, Path base, PublicKey pub, boolean checkFiles) {
        List<String> problems = new ArrayList<>();
        if (!Files.exists(ledger)) {
            return problems;
        }
        List<String> lines;
        try {
            lines = SafeFiles.readLines(ledger, 64L * 1024 * 1024, 200_000);
        } catch (InputException e) {
            problems.add(e.getMessage());
            return problems;
        }
        String prev = GENESIS;
        for (int i = 0; i < lines.size(); i++) {
            String where = "ledger line " + (i + 1) + ": ";
            String[] f = lines.get(i).split(" ");
            if (f.length < 10 || !f[0].equals("E1") || !f[f.length - 2].equals("SIG")) {
                problems.add(where + "malformed entry");
                return problems;
            }
            String entryHash = f[1];
            int n;
            try {
                n = Integer.parseInt(f[6]);
            } catch (NumberFormatException e) {
                problems.add(where + "bad file count");
                return problems;
            }
            if (f.length != 7 + n + 2) {
                problems.add(where + "file count does not match");
                return problems;
            }
            if (!f[2].equals(prev)) {
                problems.add(where + "chain broken: previous hash does not match");
            }
            String payload = String.join(" ", java.util.Arrays.copyOfRange(f, 2, 7 + n));
            if (!Hashing.sha256(payload).equals(entryHash)) {
                problems.add(where + "entry altered: hash does not match its content");
            }
            try {
                byte[] sig = Base64.getDecoder().decode(f[f.length - 1]);
                if (!Keys.verify(pub, entryHash.getBytes(StandardCharsets.US_ASCII), sig)) {
                    problems.add(where + "signature invalid");
                }
            } catch (IllegalArgumentException | GeneralSecurityException e) {
                problems.add(where + "signature unreadable");
            }
            if (checkFiles) {
                for (int k = 0; k < n; k++) {
                    String item = f[7 + k];
                    int eq = item.lastIndexOf('=');
                    if (eq <= 0) {
                        problems.add(where + "bad file item");
                        continue;
                    }
                    try {
                        Path p = SafeFiles.inside(base, item.substring(0, eq));
                        if (!Files.exists(p)) {
                            problems.add(where + "evidence file missing: " + item.substring(0, eq));
                        } else if (!Hashing.sha256(p).equals(item.substring(eq + 1))) {
                            problems.add(where + "evidence file changed: " + item.substring(0, eq));
                        }
                    } catch (InputException | IOException e) {
                        problems.add(where + e.getMessage());
                    }
                }
            }
            prev = entryHash;
        }
        return problems;
    }
}
