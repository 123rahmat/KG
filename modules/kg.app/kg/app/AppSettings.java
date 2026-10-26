package kg.app;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import kg.core.InputException;
import kg.core.SafeFiles;

/**
 * Desktop preferences in ~/.kindgleam/settings.cfg. Only known keys with checked values are read;
 * anything else is ignored. These settings change how the app looks, never what a gate decides.
 */
final class AppSettings {
    boolean dark = true;
    float scale = 1.0f;
    boolean reduceMotion;
    String defaultTier = "sil";
    boolean confirmHil = true;
    boolean assistantEnabled;
    boolean autoReview = true;
    final List<String> recent = new ArrayList<>();

    static Path file() {
        return Path.of(System.getProperty("user.home"), ".kindgleam", "settings.cfg");
    }

    static AppSettings load() {
        AppSettings s = new AppSettings();
        Path f = file();
        if (!Files.exists(f)) {
            return s;
        }
        try {
            for (String raw : SafeFiles.readLines(f, 65536, 1000)) {
                String l = raw.strip();
                int sp = l.indexOf(' ');
                if (l.startsWith("#") || sp < 0) {
                    continue;
                }
                String k = l.substring(0, sp);
                String v = l.substring(sp + 1).strip();
                switch (k) {
                    case "theme" -> s.dark = !v.equals("light");
                    case "scale" -> {
                        try {
                            float x = Float.parseFloat(v);
                            if (x >= 0.8f && x <= 1.6f) {
                                s.scale = x;
                            }
                        } catch (NumberFormatException e) {
                            // keep default
                        }
                    }
                    case "reduce_motion" -> s.reduceMotion = v.equals("true");
                    case "default_tier" -> s.defaultTier = v.matches("sil|pil|hil") ? v : "sil";
                    case "confirm_hil" -> s.confirmHil = !v.equals("false");
                    case "assistant" -> s.assistantEnabled = v.equals("on");
                    case "auto_review" -> s.autoReview = !v.equals("off");
                    case "recent" -> {
                        if (s.recent.size() < 200 && !s.recent.contains(v)) {
                            s.recent.add(v);
                        }
                    }
                    default -> {
                        // unknown keys are ignored
                    }
                }
            }
        } catch (InputException e) {
            // unreadable settings: start from defaults
        }
        return s;
    }

    void save() {
        StringBuilder sb = new StringBuilder("# Kindgleam desktop preferences\n");
        sb.append("theme ").append(dark ? "dark" : "light").append('\n');
        sb.append("scale ").append(scale).append('\n');
        sb.append("reduce_motion ").append(reduceMotion).append('\n');
        sb.append("default_tier ").append(defaultTier).append('\n');
        sb.append("confirm_hil ").append(confirmHil).append('\n');
        sb.append("assistant ").append(assistantEnabled ? "on" : "off").append('\n');
        sb.append("auto_review ").append(autoReview ? "on" : "off").append('\n');
        for (String r : recent) {
            sb.append("recent ").append(r).append('\n');
        }
        try {
            SafeFiles.writeAtomic(file(), sb.toString());
        } catch (IOException e) {
            // preferences are a convenience; failure to save is not fatal
        }
    }

    void remember(Path project) {
        String p = project.toString();
        recent.remove(p);
        recent.add(0, p);
        while (recent.size() > 200) {
            recent.remove(recent.size() - 1);
        }
    }
}
