package kg.core;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Where Kindgleam reads and writes. An installed app (Windows Program Files, a macOS .app, a
 * Linux package) is read-only, so everything Kindgleam writes for this computer goes to the
 * user's own folder: ~/.kindgleam (keys, tool seal, assistant model, logs). A source checkout
 * keeps the old behaviour and writes next to itself.
 */
public final class Places {
    private Places() {
    }

    /** True when running from an installed desktop app rather than a source checkout. */
    public static boolean installed() {
        return Boolean.getBoolean("kg.installed") || System.getProperty("jpackage.app-path") != null;
    }

    /** The user's own Kindgleam folder. */
    public static Path state() {
        return Path.of(System.getProperty("user.home"), ".kindgleam");
    }

    /** Folder for files this computer writes about the installation (tool seal, model, logs). */
    public static Path writable(Path home) {
        return installed() ? state() : home;
    }

    /** Java executable of the running runtime (the app's bundled one when installed). */
    public static Path java() {
        boolean win = System.getProperty("os.name", "").toLowerCase(Locale.ROOT).startsWith("windows");
        return Path.of(System.getProperty("java.home"), "bin", win ? "java.exe" : "java");
    }

    /** Command line that runs the Kindgleam CLI with the same Java, without needing a system Java or shell. */
    public static List<String> cli(Path home, List<String> args) {
        List<String> cmd = new ArrayList<>();
        cmd.add(java().toString());
        cmd.add("--enable-preview");
        cmd.add("-Xshare:off");
        cmd.add("-Dkg.home=" + home);
        if (installed()) {
            cmd.add("-Dkg.installed=true");
        }
        cmd.add("-p");
        cmd.add(home.resolve("build").resolve("mods").toString());
        cmd.add("-m");
        cmd.add("kg.cli/kg.cli.Main");
        cmd.addAll(args);
        return cmd;
    }
}
