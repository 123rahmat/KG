package kg.gates;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import kg.core.InputException;
import kg.core.SafeFiles;

/** G3 object symbols and G4 stack budget. */
public final class BinaryChecks {
    private BinaryChecks() {
    }

    /** G3: the linked firmware object may not depend on ANY outside symbol (no libc, no OS). */
    public static List<String> undefinedSymbols(Path nmOutput) throws InputException {
        List<String> out = new ArrayList<>();
        for (String line : SafeFiles.readLines(nmOutput, 1024 * 1024, 400)) {
            String l = line.strip();
            if (l.startsWith("$ ") || l.isEmpty() || l.endsWith(":")) {
                continue;
            }
            String[] f = l.split("\\s+");
            if (f.length == 2 && f[0].equals("U")) {
                out.add("undefined external symbol '" + f[1] + "'" + explain(f[1]));
            } else if (!(f.length >= 2)) {
                out.add("unreadable nm line: " + l);
            }
        }
        return out;
    }

    /** Plain-language reason for symbols that C++ features pull in. */
    static String explain(String sym) {
        String s = sym.startsWith("_") && sym.length() > 1 && sym.charAt(1) == '_' ? sym : sym.replaceFirst("^_(?=_)", "");
        if (s.matches("_?_Zn[wa][jmy].*") || s.matches("_?_Zdl.*") || s.matches("_?_Zda.*")) {
            return " (C++ heap: operator new/delete)";
        }
        if (s.contains("__cxa_throw") || s.contains("__cxa_allocate_exception") || s.contains("__gxx_personality")
                || s.contains("_Unwind_")) {
            return " (C++ exceptions)";
        }
        if (s.contains("__cxa_guard")) {
            return " (function-local static object with a constructor)";
        }
        if (s.contains("__cxa_atexit") || s.contains("__dso_handle")) {
            return " (global or static object with a destructor)";
        }
        if (s.contains("__cxa_pure_virtual")) {
            return " (pure virtual function called through a base class)";
        }
        if (s.contains("_ZTV") || s.contains("_ZTI") || s.contains("__dynamic_cast")) {
            return " (C++ RTTI)";
        }
        if (s.contains("_ZSt") || s.contains("_ZNSt")) {
            return " (C++ standard library code that needs a runtime)";
        }
        if (s.equals("memcpy") || s.equals("memset") || s.equals("memmove")) {
            return " (the compiler inserted a library call; copy smaller objects or use a loop)";
        }
        return "";
    }

    /**
     * G3 (C and C++): the firmware must export its ABI with plain C names, and C++ firmware may not
     * contain global objects with constructors (they would run before the controller starts).
     * Input is "nm --defined-only" output.
     */
    public static List<String> abi(Path nmDefined, List<String> required) throws InputException {
        List<String> out = new ArrayList<>();
        java.util.Set<String> defs = new java.util.HashSet<>();
        for (String line : SafeFiles.readLines(nmDefined, 4 * 1024 * 1024, 2000)) {
            String[] f = line.strip().split("\\s+");
            if (f.length >= 3 && !line.startsWith("$ ")) {
                String name = f[2].startsWith("_") && !f[2].startsWith("__") && f[2].length() > 1 && Character.isLetter(f[2].charAt(1))
                        && f[2].substring(1).startsWith("fw_") ? f[2].substring(1) : f[2];
                defs.add(name);
                if (name.contains("_GLOBAL__sub_I") || name.contains("_GLOBAL__I_")) {
                    out.add("global object with a constructor (" + name + "); firmware state must be plain data set up in fw_init");
                }
            }
        }
        for (String r : required) {
            if (!defs.contains(r)) {
                boolean mangled = defs.stream().anyMatch(d -> d.startsWith("_Z") && d.contains(r.replace("fw_", "")));
                out.add(r + " is not exported with a plain C name" + (mangled ? "; declare it extern \"C\"" : ""));
            }
        }
        return out;
    }

    /** G4: every stack frame static and within the profile limit. */
    public static List<String> stack(List<Path> suFiles, int maxFrame) throws InputException {
        List<String> out = new ArrayList<>();
        if (suFiles.isEmpty()) {
            out.add("no stack usage files found");
        }
        for (Path su : suFiles) {
            for (String line : SafeFiles.readLines(su, 1024 * 1024, 400)) {
                if (line.isBlank()) {
                    continue;
                }
                String[] f = line.split("\t");
                if (f.length != 3) {
                    out.add(su.getFileName() + ": unreadable line: " + line);
                    continue;
                }
                int bytes;
                try {
                    bytes = Integer.parseInt(f[1].strip());
                } catch (NumberFormatException e) {
                    out.add(su.getFileName() + ": bad size in " + line);
                    continue;
                }
                if (!f[2].strip().equals("static")) {
                    out.add(f[0] + " has a " + f[2].strip() + " stack frame");
                }
                if (bytes > maxFrame) {
                    out.add(f[0] + " uses " + bytes + " bytes of stack (limit " + maxFrame + ")");
                }
            }
        }
        return out;
    }
}
