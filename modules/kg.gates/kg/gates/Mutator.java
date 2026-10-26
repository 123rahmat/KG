package kg.gates;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import kg.core.InputException;
import kg.core.SafeFiles;

/**
 * G7 mutation testing: plants small, realistic bugs in firmware source, one at a time.
 * A good test suite must catch ("kill") each one. Survivors show where tests are weak.
 * Mutation sites are found only in code, never in comments, strings or preprocessor lines.
 */
public final class Mutator {
    public record Mutant(Path file, int line, int col, String from, String to, String mutatedSource) {
        /** Stable id used in reports and in the reviewed-exceptions file. */
        public String describe() {
            return file.getFileName() + ":" + line + ":" + col + " '" + from + "' -> '" + to + "'";
        }
    }

    private static final String[][] OPS = {
        {">=", ">"}, {"<=", "<"}, {"&&", "||"}, {"||", "&&"}, {"!(", "("},
        {"|= ", "&= "}, {"0.0f", "0.5f"}, {"1.0f", "0.9f"}, {" - ", " + "}, {" + ", " - "}
    };

    private Mutator() {
    }

    /** All mutation sites in one C file, in a fixed order. */
    public static List<Mutant> sites(Path file) throws InputException {
        List<String> lines = SafeFiles.readLines(file, 512 * 1024, 400);
        List<Mutant> out = new ArrayList<>();
        boolean inBlock = false;
        for (int i = 0; i < lines.size(); i++) {
            String l = lines.get(i);
            String t = l.strip();
            if (inBlock) {
                if (t.contains("*/")) {
                    inBlock = false;
                }
                continue;
            }
            if (t.startsWith("/*") && !t.contains("*/")) {
                inBlock = true;
                continue;
            }
            if (t.startsWith("#") || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) {
                continue;
            }
            String code = stripCommentsAndStrings(l);
            for (String[] op : OPS) {
                int idx = code.indexOf(op[0]);
                while (idx >= 0) {
                    if (!(op[0].equals(">=") && idx > 0 && code.charAt(idx - 1) == '>')
                            && !(op[0].equals("<=") && idx > 0 && code.charAt(idx - 1) == '<')) {
                        String mutatedLine = l.substring(0, idx) + op[1] + l.substring(idx + op[0].length());
                        List<String> copy = new ArrayList<>(lines);
                        copy.set(i, mutatedLine);
                        out.add(new Mutant(file, i + 1, idx + 1, op[0].strip(), op[1].strip(), String.join("\n", copy) + "\n"));
                    }
                    idx = code.indexOf(op[0], idx + 1);
                }
            }
            if (t.matches("[a-z_>\\-\\.]+ \\|= [A-Z_]+;")) {
                List<String> copy = new ArrayList<>(lines);
                copy.set(i, "");
                out.add(new Mutant(file, i + 1, 1, t, "(deleted)", String.join("\n", copy) + "\n"));
            }
        }
        return out;
    }

    /** Pick at most max sites, spread evenly so every part of the file is exercised. */
    public static List<Mutant> pick(List<Mutant> all, int max) {
        if (all.size() <= max) {
            return all;
        }
        List<Mutant> out = new ArrayList<>();
        for (int k = 0; k < max; k++) {
            out.add(all.get((int) ((long) k * all.size() / max)));
        }
        return out;
    }

    /** Same length as the input, with comment and string contents blanked out. */
    private static String stripCommentsAndStrings(String l) {
        StringBuilder sb = new StringBuilder(l);
        int i = 0;
        while (i < sb.length()) {
            char c = sb.charAt(i);
            if (c == '/' && i + 1 < sb.length() && sb.charAt(i + 1) == '/') {
                for (int k = i; k < sb.length(); k++) {
                    sb.setCharAt(k, ' ');
                }
                break;
            }
            if (c == '/' && i + 1 < sb.length() && sb.charAt(i + 1) == '*') {
                int end = sb.indexOf("*/", i + 2);
                int stop = end < 0 ? sb.length() : end + 2;
                for (int k = i; k < stop; k++) {
                    sb.setCharAt(k, ' ');
                }
                i = stop;
                continue;
            }
            if (c == '"' || c == '\'') {
                int k = i + 1;
                while (k < sb.length() && sb.charAt(k) != c) {
                    sb.setCharAt(k, ' ');
                    k++;
                }
                i = k + 1;
                continue;
            }
            i++;
        }
        return sb.toString();
    }
}
