package kg.app;

import java.awt.Color;
import java.awt.Font;
import java.awt.GraphicsEnvironment;
import java.util.Arrays;
import java.util.List;

/** Colours, type and spacing for the dark and light themes. Every component reads from here. */
final class Theme {
    final boolean dark;
    final Color bg;
    final Color sidebar;
    final Color surface;
    final Color surface2;
    final Color hover;
    final Color border;
    final Color text;
    final Color muted;
    final Color faint;
    final Color accent;
    final Color accentSoft;
    final Color pass;
    final Color passSoft;
    final Color fail;
    final Color failSoft;
    final Color warn;
    final Color warnSoft;
    final Color scopeBg;
    final Color scopeGrid;
    final Color[] series;
    final float scale;
    final Font font;
    final Font mono;

    private Theme(boolean dark, float scale) {
        this.dark = dark;
        this.scale = scale;
        if (dark) {
            bg = new Color(0x111316);
            sidebar = new Color(0x0c0e10);
            surface = new Color(0x1a1d21);
            surface2 = new Color(0x22262b);
            hover = new Color(0x2a2f35);
            border = new Color(0x2f343a);
            text = new Color(0xe8eaed);
            muted = new Color(0x9aa0a6);
            faint = new Color(0x5f6368);
            accent = new Color(0x7c9cff);
            accentSoft = new Color(0x7c9cff & 0xffffff | 0x33000000, true);
            pass = new Color(0x3ecf8e);
            passSoft = new Color(0x1f3d30);
            fail = new Color(0xff6b6b);
            failSoft = new Color(0x472323);
            warn = new Color(0xf5b94a);
            warnSoft = new Color(0x463a1f);
            scopeBg = new Color(0x0d0f12);
            scopeGrid = new Color(0x22272d);
            series = new Color[] {new Color(0x4fc3f7), new Color(0xffb74d), new Color(0x81c784), new Color(0xba68c8),
                new Color(0xf06292), new Color(0x4db6ac), new Color(0xfff176), new Color(0x90a4ae)};
        } else {
            bg = new Color(0xf7f7f8);
            sidebar = new Color(0xefeff1);
            surface = Color.WHITE;
            surface2 = new Color(0xf3f4f6);
            hover = new Color(0xe9eaee);
            border = new Color(0xe2e4e8);
            text = new Color(0x1f2328);
            muted = new Color(0x5f6672);
            faint = new Color(0xa0a6b0);
            accent = new Color(0x3b5bdb);
            accentSoft = new Color(0x3b5bdb & 0xffffff | 0x22000000, true);
            pass = new Color(0x1e9e63);
            passSoft = new Color(0xe3f6ec);
            fail = new Color(0xd63b3b);
            failSoft = new Color(0xfde8e8);
            warn = new Color(0xc27c0e);
            warnSoft = new Color(0xfdf1dc);
            scopeBg = new Color(0xfcfcfd);
            scopeGrid = new Color(0xe8eaee);
            series = new Color[] {new Color(0x1976d2), new Color(0xef6c00), new Color(0x2e7d32), new Color(0x7b1fa2),
                new Color(0xc2185b), new Color(0x00897b), new Color(0xf9a825), new Color(0x546e7a)};
        }
        font = pick(List.of("Inter", "Segoe UI", "SF Pro Text", "Helvetica Neue", "Ubuntu", "Cantarell", "DejaVu Sans"), Font.SANS_SERIF)
                .deriveFont(Font.PLAIN, 13f * scale);
        mono = pick(List.of("JetBrains Mono", "Cascadia Mono", "SF Mono", "Consolas", "Menlo", "DejaVu Sans Mono"), Font.MONOSPACED)
                .deriveFont(Font.PLAIN, 12f * scale);
    }

    static Theme of(boolean dark, float scale) {
        return new Theme(dark, scale);
    }

    private static Font pick(List<String> names, String fallback) {
        List<String> have = Arrays.asList(GraphicsEnvironment.getLocalGraphicsEnvironment().getAvailableFontFamilyNames());
        for (String n : names) {
            if (have.contains(n)) {
                return new Font(n, Font.PLAIN, 13);
            }
        }
        return new Font(fallback, Font.PLAIN, 13);
    }

    Font size(float pt, int style) {
        return font.deriveFont(style, pt * scale);
    }

    int px(int v) {
        return Math.round(v * scale);
    }

    Color status(String s) {
        return switch (s) {
            case "PASS", "DONE", "OK", "READY" -> pass;
            case "FAIL", "FAILED" -> fail;
            case "BLOCKED", "RUNNING" -> warn;
            default -> muted;
        };
    }

    Color statusSoft(String s) {
        return switch (s) {
            case "PASS", "DONE", "OK", "READY" -> passSoft;
            case "FAIL", "FAILED" -> failSoft;
            case "BLOCKED", "RUNNING" -> warnSoft;
            default -> surface2;
        };
    }

    static Color mix(Color a, Color b, float t) {
        float u = Math.max(0f, Math.min(1f, t));
        return new Color(Math.round(a.getRed() + (b.getRed() - a.getRed()) * u),
                Math.round(a.getGreen() + (b.getGreen() - a.getGreen()) * u),
                Math.round(a.getBlue() + (b.getBlue() - a.getBlue()) * u),
                Math.round(a.getAlpha() + (b.getAlpha() - a.getAlpha()) * u));
    }
}
