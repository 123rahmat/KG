package kg.cli;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.PublicKey;
import java.util.List;
import kg.core.InputException;
import kg.core.Profile;
import kg.core.SafeFiles;
import kg.verdict.Keys;
import kg.verdict.Ledger;

/**
 * kindgleam command line. Exit codes: 0 = PASS / ok, 1 = FAIL, 2 = usage or input error.
 */
public final class Main {
    private Main() {
    }

    public static void main(String[] args) {
        int rc;
        String wrong = kg.core.Platform.check(Path.of(System.getProperty("kg.home", ".")));
        if (wrong != null) {
            System.err.println("kindgleam: " + wrong);
            System.exit(5);
        }
        try {
            rc = run(args);
        } catch (InputException e) {
            System.err.println("kindgleam: input error: " + e.getMessage());
            rc = 2;
        } catch (Exception e) {
            System.err.println("kindgleam: " + e.getMessage());
            rc = 2;
        }
        System.exit(rc);
    }

    private static Path home() throws InputException {
        String h = System.getProperty("kg.home");
        if (h == null || h.isBlank()) {
            throw new InputException("kg.home not set; start kindgleam with its launcher");
        }
        return Path.of(h).toAbsolutePath().normalize();
    }

    static int run(String[] args) throws Exception {
        if (args.length == 0) {
            usage();
            return 2;
        }
        Path project = Path.of("").toAbsolutePath().normalize();
        Integer early = harness(args, project);
        if (early != null) {
            return early;
        }
        if (args[0].equals("model")) {
            return model(args);
        }
        boolean lines = false;
        boolean acceptGolden = false;
        String tier = "sil";
        String extra = null;
        for (int i = 1; i < args.length; i++) {
            String a = args[i];
            if (a.equals("--format=lines")) {
                lines = true;
            } else if (a.equals("--accept-golden")) {
                acceptGolden = true;
            } else if (a.startsWith("--tier=")) {
                tier = a.substring(7);
                if (!List.of("sil", "pil", "hil").contains(tier)) {
                    throw new InputException("--tier must be sil, pil or hil");
                }
            } else if (a.startsWith("--project=")) {
                project = Path.of(a.substring(10)).toAbsolutePath().normalize();
            } else if (!a.startsWith("--") && extra == null) {
                extra = a;
            } else {
                throw new InputException("unknown option " + a);
            }
        }
        switch (args[0]) {
            case "keygen" -> {
                KeyPair kp = Keys.generate(Keys.defaultDir());
                System.out.println("Created signing key in " + Keys.defaultDir());
                System.out.println("Put this line in each project's profile.cfg:");
                System.out.println("LEDGER_KEY_FP " + Keys.fingerprint(kp.getPublic()));
                return 0;
            }
            case "fingerprint" -> {
                System.out.println("LEDGER_KEY_FP " + Keys.fingerprint(Keys.loadPublic(Keys.defaultDir())));
                return 0;
            }
            case "baseline" -> {
                Baseline.write(home(), Keys.loadPrivate(Keys.defaultDir()));
                System.out.println("Signed tool baseline written to " + Baseline.dir(home()).resolve("baseline.txt"));
                return 0;
            }
            case "sign-limits" -> {
                Path cfg = SafeFiles.inside(project, "limits.cfg");
                kg.gates.Limits.load(cfg);
                byte[] sig = Keys.sign(Keys.loadPrivate(Keys.defaultDir()), Files.readAllBytes(cfg));
                SafeFiles.writeAtomic(project.resolve("limits.sig"), java.util.Base64.getEncoder().encodeToString(sig) + "\n");
                System.out.println("limits.cfg checked and signed. Only the holder of the signing key can change these limits.");
                return 0;
            }
            case "check", "verify" -> {
                Coordinator c = new Coordinator(home(), project, lines);
                return c.run(args[0].equals("verify"), tier);
            }
            case "eval" -> {
                Coordinator c = new Coordinator(home(), project, lines);
                return c.runEval(acceptGolden);
            }
            case "install-hooks" -> {
                Path git = project.resolve(".git");
                if (!Files.isDirectory(git) || Files.isSymbolicLink(git)) {
                    throw new InputException("not a git repository: " + project);
                }
                Path hook = git.resolve("hooks").resolve("pre-commit");
                String marker = "# kindgleam pre-commit hook";
                if (Files.exists(hook) && !Files.readString(hook).contains(marker)) {
                    throw new InputException("a different pre-commit hook already exists; refusing to overwrite it");
                }
                Files.createDirectories(hook.getParent());
                SafeFiles.writeAtomic(hook, "#!/bin/sh\n" + marker + "\n# Blocks a commit whose firmware fails the fast gates.\n"
                        + "exec \"" + home().resolve("bin/kindgleam") + "\" check --project=\"$(git rev-parse --show-toplevel)\"\n");
                try {
                    Files.setPosixFilePermissions(hook, java.nio.file.attribute.PosixFilePermissions.fromString("rwxr-xr-x"));
                } catch (UnsupportedOperationException e) {
                    // Windows: git for Windows runs hooks without the executable bit
                }
                System.out.println("Installed " + hook + ": every commit now runs 'kindgleam check' first.");
                return 0;
            }
            case "status" -> {
                Path latest = project.resolve("jobs").resolve("latest");
                if (!Files.exists(latest)) {
                    System.out.println("No runs yet.");
                    return 0;
                }
                String run = Files.readString(latest).strip();
                for (String l : SafeFiles.readLines(SafeFiles.inside(project, "jobs/" + run + "/progress.log"),
                        4 * 1024 * 1024, 2000)) {
                    System.out.println(l);
                }
                return 0;
            }
            case "report" -> {
                if (extra == null || !extra.matches("run-\\d{4}")) {
                    throw new InputException("usage: kindgleam report run-NNNN");
                }
                Path dir = SafeFiles.inside(project, "jobs/" + extra);
                for (String l : SafeFiles.readLines(dir.resolve("report.txt"), 4 * 1024 * 1024, 2000)) {
                    System.out.println(l);
                }
                return 0;
            }
            case "ledger-verify" -> {
                Profile prof = Profile.load(SafeFiles.inside(project, "profile.cfg"));
                PublicKey pub = Keys.loadPublic(Keys.defaultDir());
                if (!Keys.fingerprint(pub).equals(prof.ledgerKeyFingerprint)) {
                    System.out.println("FAIL: signing key does not match LEDGER_KEY_FP in profile.cfg");
                    return 1;
                }
                List<String> problems = Ledger.verify(project.resolve("evidence").resolve("ledger.log"),
                        project, pub, true);
                if (problems.isEmpty()) {
                    System.out.println("Ledger intact: chain, hashes, signatures and evidence files all verified.");
                    return 0;
                }
                problems.forEach(p -> System.out.println("FAIL: " + p));
                return 1;
            }
            default -> {
                usage();
                return 2;
            }
        }
    }

    /** memory and skill commands take positional arguments, so they are handled before option parsing. */
    private static Integer harness(String[] args, Path project) throws Exception {
        switch (args[0]) {
            case "memory" -> {
                if (args.length >= 5 && args[1].equals("add")) {
                    String text = String.join(" ", java.util.Arrays.copyOfRange(args, 4, args.length));
                    String h = kg.harness.Memory.add(project, args[2], args[3], text);
                    System.out.println("Added to memory/" + args[2] + ".log (" + h.substring(0, 12) + "...)");
                    return 0;
                }
                if (args.length == 3 && args[1].equals("list")) {
                    kg.harness.Memory.list(project, args[2]).forEach(System.out::println);
                    return 0;
                }
                if (args.length == 2 && args[1].equals("verify")) {
                    List<String> all = new java.util.ArrayList<>();
                    for (String log : kg.harness.Memory.LOGS) {
                        all.addAll(kg.harness.Memory.verify(project, log));
                    }
                    if (all.isEmpty()) {
                        System.out.println("Memory intact: every log's hash chain verified.");
                        return 0;
                    }
                    all.forEach(x -> System.out.println("FAIL: " + x));
                    return 1;
                }
                throw new InputException("usage: kindgleam memory add <decisions|facts> <source> <text> | list <log> | verify");
            }
            case "skill" -> {
                if (args.length == 2 && args[1].equals("list")) {
                    kg.harness.Skills.names(home()).forEach(System.out::println);
                    return 0;
                }
                if (args.length == 3 && args[1].equals("show")) {
                    kg.harness.Skills.show(home(), args[2]).forEach(System.out::println);
                    return 0;
                }
                throw new InputException("usage: kindgleam skill list | skill show <name>");
            }
            default -> {
                return null;
            }
        }
    }

    private static void usage() throws IOException {
        System.out.println("""
                usage: kindgleam <command> [options]
                  keygen                     create the ledger signing key (once per machine)
                  fingerprint                print this machine's LEDGER_KEY_FP line for profile.cfg
                  baseline                   sign the installed tool files (after install or upgrade)
                  sign-limits                sign the board's safe operating limits (hardware owner)
                  check                      fast advisory checks: inputs, spec, build gates
                  verify [--tier=sil|pil|hil] full agent chain, verdict and ledger entry
                  eval [--accept-golden]     check the verification system itself: repeatability,
                                             golden-trace drift, gate self-test, tool integrity
                  status                     progress log of the latest run
                  report run-NNNN            report of a stored run
                  ledger-verify              verify chain, signatures and evidence files
                  memory add <log> <source> <text> | memory list <log> | memory verify
                  skill list | skill show <name>
                  model status | model install <file.gguf> | model verify
                                             the assistant's model: check, install and seal it
                  install-hooks              git pre-commit hook that runs 'kindgleam check'
                options: --project=<dir>  --format=lines""");
    }

    /** model status | install <file> | verify. The model file is never modified. */
    private static int model(String[] args) throws Exception {
        kg.assist.ModelStore store = new kg.assist.ModelStore(home());
        String sub = args.length > 1 ? args[1] : "status";
        switch (sub) {
            case "status" -> {
                kg.assist.ModelStore.Status st = store.status();
                System.out.println((st.ready() ? "READY  " : "NOT READY  ") + st.message());
                return st.ready() ? 0 : 1;
            }
            case "install" -> {
                if (args.length < 3) {
                    throw new InputException("usage: kindgleam model install <downloaded .gguf file>");
                }
                Path f = Path.of(args[2]).toAbsolutePath().normalize();
                System.out.println("Checking " + f + " against the published fingerprints (this reads the whole file)...");
                String sha = store.install(f);
                System.out.println("Installed unchanged in " + store.dir() + ". SHA-256 " + sha);
                return 0;
            }
            case "verify" -> {
                System.out.println("OK  the model file is a published one: SHA-256 " + store.verifyFully());
                return 0;
            }
            default -> throw new InputException("usage: kindgleam model status | install <file> | verify");
        }
    }
}
