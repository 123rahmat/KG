package kg.core;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** The rule set in force. Unknown keys and missing keys are errors. */
public final class Profile {
    public final String name;
    public final List<String> requiredGates;
    public final int stackMaxFrame;
    public final int agentTimeoutS;
    public final String compiler;
    public final String plantModel;
    public final boolean airgapEnforce;
    public final boolean sandboxRequired;
    public final String ledgerKeyFingerprint;
    public final boolean calibrationRequired;
    public final int mutantsMax;
    public final int mutationMinScore;
    public final int coverageMinLines;
    public final int coverageMinBranches;
    public final boolean timingRequired;
    /** Firmware language. Optional key; only "c" (C11) in this release. */
    public final String language;
    /** Python interpreter for test generators in tests/. Optional key. */
    public final String python;

    private Profile(String name, List<String> gates, int stack, int timeout, String compiler,
                    String plant, boolean airgap, boolean sandbox, String keyFp, boolean calRequired, int mutantsMax, int mutationMinScore,
                    int covLines, int covBranches, boolean timing, String language, String python) {
        this.name = name;
        this.requiredGates = Collections.unmodifiableList(gates);
        this.stackMaxFrame = stack;
        this.agentTimeoutS = timeout;
        this.compiler = compiler;
        this.plantModel = plant;
        this.airgapEnforce = airgap;
        this.sandboxRequired = sandbox;
        this.ledgerKeyFingerprint = keyFp;
        this.calibrationRequired = calRequired;
        this.mutantsMax = mutantsMax;
        this.mutationMinScore = mutationMinScore;
        this.coverageMinLines = covLines;
        this.coverageMinBranches = covBranches;
        this.timingRequired = timing;
        this.language = language;
        this.python = python;
    }

    public boolean cpp() {
        return language.equals("c++");
    }

    /** C++ driver that matches the C compiler: g++ for gcc, clang++ for clang. */
    public String cxx() {
        return compiler.equals("clang") ? "clang++" : "g++";
    }

    public static Profile load(Path p) throws InputException {
        String name = null;
        List<String> gates = null;
        Integer stack = null;
        Integer timeout = null;
        String compiler = null;
        String plant = null;
        Boolean airgap = null;
        Boolean sandbox = null;
        String keyFp = null;
        Boolean cal = null;
        Integer mutants = null;
        Integer minScore = null;
        Integer covLines = null;
        Integer covBranches = null;
        Boolean timing = null;
        String language = "c";
        String python = System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT).startsWith("windows") ? "python" : "python3";
        Set<String> seen = new HashSet<>();
        int ln = 0;
        for (String raw : SafeFiles.readLines(p, 8192, 300)) {
            ln++;
            String line = raw.strip();
            if (line.isEmpty() || line.startsWith("#")) {
                continue;
            }
            String[] t = line.split("\\s+");
            String where = "profile.cfg:" + ln + ": ";
            if (!seen.add(t[0])) {
                throw new InputException(where + "duplicate key " + t[0]);
            }
            try {
                switch (t[0]) {
                    case "PROFILE" -> name = one(t, where);
                    case "REQUIRED_GATES" -> {
                        gates = new ArrayList<>();
                        for (int i = 1; i < t.length; i++) {
                            if (!t[i].matches("G\\d{1,2}")) {
                                throw new InputException(where + "bad gate name " + t[i]);
                            }
                            gates.add(t[i]);
                        }
                        if (gates.isEmpty()) {
                            throw new InputException(where + "no gates listed");
                        }
                    }
                    case "STACK_MAX_FRAME" -> stack = Integer.parseInt(one(t, where));
                    case "AGENT_TIMEOUT_S" -> timeout = Integer.parseInt(one(t, where));
                    case "COMPILER" -> {
                        compiler = one(t, where);
                        if (!compiler.equals("gcc") && !compiler.equals("clang")) {
                            throw new InputException(where + "COMPILER must be gcc or clang");
                        }
                    }
                    case "PLANT_MODEL" -> plant = one(t, where);
                    case "LANGUAGE" -> {
                        language = one(t, where);
                        if (language.equals("c++")) {
                            throw new InputException(where + "C++ firmware is not enabled in this release; firmware is C (LANGUAGE c)");
                        }
                        if (!language.equals("c")) {
                            throw new InputException(where + "LANGUAGE must be c");
                        }
                    }
                    case "PYTHON" -> {
                        python = one(t, where);
                        if (!python.matches("[A-Za-z0-9._/\\\\:-]{1,200}")) {
                            throw new InputException(where + "PYTHON must be an interpreter name or path");
                        }
                    }
                    case "AIRGAP" -> airgap = flag(one(t, where), "enforce", "warn", where);
                    case "COVERAGE_MIN_LINES" -> covLines = Integer.parseInt(one(t, where));
                    case "COVERAGE_MIN_BRANCHES" -> covBranches = Integer.parseInt(one(t, where));
                    case "TIMING" -> timing = flag(one(t, where), "required", "advisory", where);
                    case "MUTANTS_MAX" -> mutants = Integer.parseInt(one(t, where));
                    case "MUTATION_MIN_SCORE" -> minScore = Integer.parseInt(one(t, where));
                    case "CALIBRATION" -> cal = flag(one(t, where), "required", "optional", where);
                    case "SANDBOX" -> sandbox = flag(one(t, where), "required", "best-effort", where);
                    case "LEDGER_KEY_FP" -> {
                        keyFp = one(t, where);
                        if (!keyFp.matches("[0-9a-f]{64}")) {
                            throw new InputException(where + "LEDGER_KEY_FP must be a SHA-256 hex fingerprint");
                        }
                    }
                    default -> throw new InputException(where + "unknown key " + t[0]);
                }
            } catch (NumberFormatException e) {
                throw new InputException(where + "bad number");
            }
        }
        if (name == null || gates == null || stack == null || timeout == null || compiler == null
                || plant == null || airgap == null || sandbox == null || keyFp == null || cal == null || mutants == null || minScore == null || covLines == null || covBranches == null || timing == null) {
            throw new InputException("profile.cfg: missing one of PROFILE, REQUIRED_GATES, STACK_MAX_FRAME, "
                    + "AGENT_TIMEOUT_S, COMPILER, PLANT_MODEL, AIRGAP, SANDBOX, CALIBRATION, MUTANTS_MAX, MUTATION_MIN_SCORE, COVERAGE_MIN_LINES, COVERAGE_MIN_BRANCHES, TIMING, LEDGER_KEY_FP");
        }
        if (covLines < 0 || covLines > 100 || covBranches < 0 || covBranches > 100) {
            throw new InputException("profile.cfg: COVERAGE_MIN_LINES and COVERAGE_MIN_BRANCHES must be 0..100");
        }
        if (mutants < 1 || mutants > 500 || minScore < 0 || minScore > 100) {
            throw new InputException("profile.cfg: MUTANTS_MAX must be 1..500 and MUTATION_MIN_SCORE 0..100");
        }
        if (stack < 16 || stack > 65536 || timeout < 1 || timeout > 3600) {
            throw new InputException("profile.cfg: STACK_MAX_FRAME or AGENT_TIMEOUT_S out of range");
        }
        return new Profile(name, gates, stack, timeout, compiler, plant, airgap, sandbox, keyFp, cal, mutants, minScore,
                covLines, covBranches, timing, language, python);
    }

    private static String one(String[] t, String where) throws InputException {
        if (t.length != 2) {
            throw new InputException(where + t[0] + " expects one value");
        }
        return t[1];
    }

    private static boolean flag(String v, String yes, String no, String where) throws InputException {
        if (v.equals(yes)) {
            return true;
        }
        if (v.equals(no)) {
            return false;
        }
        throw new InputException(where + "expected " + yes + " or " + no);
    }
}
