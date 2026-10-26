package kg.gates;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;
import kg.core.InputException;
import kg.core.SafeFiles;

/**
 * G1: firmware source policy. Token-level scan that skips comments and string literals,
 * matches whole identifiers only, and allows only a short list of headers.
 */
public final class SourceScan {
    private static final Set<String> BANNED = Set.of(
            "malloc", "calloc", "realloc", "free", "alloca", "goto", "setjmp", "longjmp",
            "system", "popen", "fork", "exec", "execv", "execve", "socket", "connect", "bind", "listen",
            "gets", "strcpy", "strcat", "sprintf", "vsprintf", "printf", "fprintf", "fopen", "scanf",
            "pragma", "_Pragma", "asm", "__asm__", "__asm", "__attribute__");
    /** Extra rules for C++ files: no heap, no exceptions, no RTTI, no thread-local storage. */
    private static final Set<String> BANNED_CPP = Set.of(
            "new", "delete", "throw", "try", "catch", "dynamic_cast", "typeid", "thread_local", "co_await", "co_yield",
            "co_return", "reinterpret_cast");
    private static final Pattern INCLUDE = Pattern.compile("^\\s*#\\s*include\\s*(.*)$");
    private static final Pattern ALLOWED_INCLUDE =
            Pattern.compile("(<(stdint|stdbool|stddef)\\.h>|\"fw_[a-z0-9_]+\\.h\")");
    /** C++: only headers that allocate nothing and need no runtime library. */
    private static final Pattern ALLOWED_INCLUDE_CPP =
            Pattern.compile("(<(cstdint|cstddef|climits|cfloat|array|type_traits|limits|utility)>|<(stdint|stdbool|stddef)\\.h>"
                    + "|\"fw_[a-z0-9_]+\\.(h|hpp)\")");

    private SourceScan() {
    }

    public static List<String> scan(Path file) throws InputException {
        List<String> lines = SafeFiles.readLines(file, 512 * 1024, 400);
        List<String> out = new ArrayList<>();
        String name = file.getFileName().toString();
        boolean cpp = name.endsWith(".cpp") || name.endsWith(".hpp");
        Pattern allowed = cpp ? ALLOWED_INCLUDE_CPP : ALLOWED_INCLUDE;
        for (int i = 0; i < lines.size(); i++) {
            var m = INCLUDE.matcher(lines.get(i));
            if (m.matches() && !allowed.matcher(m.group(1).strip()).matches()) {
                out.add(name + ":" + (i + 1) + " include not allowed: " + m.group(1).strip());
            }
        }
        String src = String.join("\n", lines);
        int n = src.length();
        int i = 0;
        int line = 1;
        char prev = ' ';  // last significant character outside comments and strings
        while (i < n) {
            char c = src.charAt(i);
            if (c == '\n') {
                line++;
                i++;
            } else if (c == '/' && i + 1 < n && src.charAt(i + 1) == '/') {
                while (i < n && src.charAt(i) != '\n') {
                    i++;
                }
            } else if (c == '/' && i + 1 < n && src.charAt(i + 1) == '*') {
                int start = line;
                i += 2;
                while (i + 1 < n && !(src.charAt(i) == '*' && src.charAt(i + 1) == '/')) {
                    if (src.charAt(i) == '\n') {
                        line++;
                    }
                    i++;
                }
                if (i + 1 >= n) {
                    out.add(name + ":" + start + " unterminated comment");
                }
                i += 2;
            } else if (c == '"' || c == '\'') {
                char q = c;
                i++;
                while (i < n && src.charAt(i) != q && src.charAt(i) != '\n') {
                    if (src.charAt(i) == '\\') {
                        i++;
                    }
                    i++;
                }
                i++;
            } else if (Character.isLetter(c) || c == '_') {
                int s = i;
                while (i < n && (Character.isLetterOrDigit(src.charAt(i)) || src.charAt(i) == '_')) {
                    i++;
                }
                String id = src.substring(s, i);
                if (BANNED.contains(id)) {
                    out.add(name + ":" + line + " forbidden '" + id + "'");
                } else if (cpp && BANNED_CPP.contains(id) && !(id.equals("delete") && prev == '=')) {
                    out.add(name + ":" + line + " forbidden in firmware C++ '" + id + "'" + cppReason(id));
                }
                prev = 'a';
            } else {
                if (!Character.isWhitespace(c)) {
                    prev = c;
                }
                i++;
            }
        }
        return out;
    }

    private static String cppReason(String id) {
        return switch (id) {
            case "new", "delete" -> " (heap memory; use static storage)";
            case "throw", "try", "catch" -> " (exceptions are disabled; return an error code)";
            case "dynamic_cast", "typeid" -> " (RTTI is disabled)";
            case "reinterpret_cast" -> " (unchecked type punning; use memcpy-free designs or a reviewed C helper)";
            default -> "";
        };
    }
}
