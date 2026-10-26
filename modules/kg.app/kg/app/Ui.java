package kg.app;

import java.awt.AlphaComposite;
import java.awt.BasicStroke;
import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Component;
import java.awt.Cursor;
import java.awt.Dimension;
import java.awt.FlowLayout;
import java.awt.Font;
import java.awt.FontMetrics;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.Insets;
import java.awt.RenderingHints;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.awt.geom.Path2D;
import java.awt.geom.RoundRectangle2D;
import javax.swing.BorderFactory;
import javax.swing.Box;
import javax.swing.BoxLayout;
import javax.swing.JButton;
import javax.swing.JComponent;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JScrollBar;
import javax.swing.JScrollPane;
import javax.swing.JTextArea;
import javax.swing.Timer;
import javax.swing.plaf.basic.BasicScrollBarUI;

/** Small custom-painted components: cards, buttons, nav items, pills, icons, smooth animation. */
final class Ui {
    /** Current theme. Set by the App before building any page. */
    static Theme t = Theme.of(true, 1f);
    /** Respect the "reduce motion" setting. */
    static boolean reduceMotion;

    private Ui() {
    }

    static void hints(Graphics2D g) {
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_STROKE_CONTROL, RenderingHints.VALUE_STROKE_PURE);
        g.setRenderingHint(RenderingHints.KEY_FRACTIONALMETRICS, RenderingHints.VALUE_FRACTIONALMETRICS_ON);
    }

    /* ------------------------------------------------------------ animation */

    /** Eases a value toward a target at ~60 fps and repaints its owner. */
    static final class Anim {
        private final Component owner;
        private final Timer timer;
        float value;
        float target;

        Anim(Component owner, float start) {
            this.owner = owner;
            this.value = start;
            this.target = start;
            this.timer = new Timer(16, e -> tick());
        }

        void to(float v) {
            target = v;
            if (reduceMotion) {
                value = v;
                owner.repaint();
                return;
            }
            if (!timer.isRunning()) {
                timer.start();
            }
        }

        private void tick() {
            value += (target - value) * 0.22f;
            if (Math.abs(target - value) < 0.004f) {
                value = target;
                timer.stop();
            }
            owner.repaint();
        }
    }

    /* ------------------------------------------------------------ containers */

    static class Card extends JPanel {
        private static final long serialVersionUID = 1L;
        private final int radius;
        Color fill;

        Card() {
            this(t.px(14));
        }

        Card(int radius) {
            this.radius = radius;
            this.fill = t.surface;
            setOpaque(false);
            setLayout(new BorderLayout());
            setBorder(BorderFactory.createEmptyBorder(t.px(16), t.px(18), t.px(16), t.px(18)));
        }

        @Override
        protected void paintComponent(Graphics g0) {
            Graphics2D g = (Graphics2D) g0.create();
            hints(g);
            g.setColor(fill);
            g.fill(new RoundRectangle2D.Float(0, 0, getWidth() - 1, getHeight() - 1, radius, radius));
            g.setColor(t.border);
            g.draw(new RoundRectangle2D.Float(0.5f, 0.5f, getWidth() - 2, getHeight() - 2, radius, radius));
            g.dispose();
            super.paintComponent(g0);
        }
    }

    static JPanel column() {
        JPanel p = new JPanel();
        p.setOpaque(false);
        p.setLayout(new BoxLayout(p, BoxLayout.Y_AXIS));
        return p;
    }

    static JPanel row(int gap) {
        JPanel p = new JPanel(new FlowLayout(FlowLayout.LEFT, gap, 0));
        p.setOpaque(false);
        return p;
    }

    static Component gap(int h) {
        return Box.createVerticalStrut(t.px(h));
    }

    static JComponent left(JComponent c) {
        c.setAlignmentX(Component.LEFT_ALIGNMENT);
        return c;
    }

    static JScrollPane scroll(Component c) {
        JScrollPane s = new JScrollPane(c);
        s.setBorder(BorderFactory.createEmptyBorder());
        s.setOpaque(false);
        s.getViewport().setOpaque(false);
        s.getVerticalScrollBar().setUnitIncrement(t.px(18));
        s.getHorizontalScrollBar().setUnitIncrement(t.px(18));
        thin(s.getVerticalScrollBar());
        thin(s.getHorizontalScrollBar());
        return s;
    }

    private static void thin(JScrollBar b) {
        b.setOpaque(false);
        b.setPreferredSize(new Dimension(t.px(10), t.px(10)));
        b.setUI(new BasicScrollBarUI() {
            @Override
            protected void paintTrack(Graphics g, JComponent c, java.awt.Rectangle r) {
                // invisible track
            }

            @Override
            protected void paintThumb(Graphics g0, JComponent c, java.awt.Rectangle r) {
                Graphics2D g = (Graphics2D) g0.create();
                hints(g);
                g.setColor(isThumbRollover() ? t.faint : t.border);
                g.fillRoundRect(r.x + 2, r.y + 2, r.width - 4, r.height - 4, 8, 8);
                g.dispose();
            }

            @Override
            protected JButton createDecreaseButton(int o) {
                return zero();
            }

            @Override
            protected JButton createIncreaseButton(int o) {
                return zero();
            }

            private JButton zero() {
                JButton z = new JButton();
                z.setPreferredSize(new Dimension(0, 0));
                return z;
            }
        });
    }

    /* ------------------------------------------------------------ text */

    static JLabel label(String s, float size, int style, Color c) {
        JLabel l = new JLabel(s);
        l.setFont(t.size(size, style));
        l.setForeground(c);
        return l;
    }

    static JLabel h1(String s) {
        return label(s, 22f, Font.BOLD, t.text);
    }

    static JLabel h2(String s) {
        return label(s, 15f, Font.BOLD, t.text);
    }

    static JLabel muted(String s) {
        return label(s, 12.5f, Font.PLAIN, t.muted);
    }

    static JTextArea textBlock(String s, boolean mono) {
        JTextArea a = new JTextArea(s);
        a.setEditable(false);
        a.setLineWrap(true);
        ((javax.swing.text.DefaultCaret) a.getCaret()).setUpdatePolicy(javax.swing.text.DefaultCaret.NEVER_UPDATE);
        a.setWrapStyleWord(true);
        a.setOpaque(false);
        a.setForeground(t.text);
        a.setFont(mono ? t.mono : t.font);
        a.setBorder(BorderFactory.createEmptyBorder());
        a.setCaretColor(t.text);
        a.setSelectionColor(t.accentSoft);
        return a;
    }

    /* ------------------------------------------------------------ buttons and pills */

    enum Kind { PRIMARY, SECONDARY, GHOST, DANGER }

    static final class Btn extends JButton {
        private static final long serialVersionUID = 1L;
        private final Kind kind;
        private final transient Anim hover;
        private final String icon;

        Btn(String text, Kind kind) {
            this(text, kind, null);
        }

        Btn(String text, Kind kind, String icon) {
            super(text);
            this.kind = kind;
            this.icon = icon;
            this.hover = new Anim(this, 0f);
            setFont(t.size(13f, Font.BOLD));
            setFocusPainted(false);
            setContentAreaFilled(false);
            setBorderPainted(false);
            setOpaque(false);
            setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
            setMargin(new Insets(0, 0, 0, 0));
            addMouseListener(new MouseAdapter() {
                @Override
                public void mouseEntered(MouseEvent e) {
                    hover.to(1f);
                }

                @Override
                public void mouseExited(MouseEvent e) {
                    hover.to(0f);
                }
            });
        }

        @Override
        public Dimension getPreferredSize() {
            FontMetrics fm = getFontMetrics(getFont());
            int w = fm.stringWidth(getText()) + t.px(icon == null ? 28 : 46);
            return new Dimension(w, t.px(34));
        }

        @Override
        public Dimension getMaximumSize() {
            return getPreferredSize();
        }

        @Override
        public Dimension getMinimumSize() {
            return getPreferredSize();
        }

        @Override
        protected void paintComponent(Graphics g0) {
            Graphics2D g = (Graphics2D) g0.create();
            hints(g);
            boolean en = isEnabled();
            float h = en ? hover.value : 0f;
            Color bgc;
            Color fg;
            switch (kind) {
                case PRIMARY -> {
                    bgc = Theme.mix(t.accent, t.dark ? Color.WHITE : Color.BLACK, 0.12f * h);
                    fg = Color.WHITE;
                }
                case DANGER -> {
                    bgc = Theme.mix(t.fail, t.dark ? Color.WHITE : Color.BLACK, 0.12f * h);
                    fg = Color.WHITE;
                }
                case SECONDARY -> {
                    bgc = Theme.mix(t.surface2, t.hover, h);
                    fg = t.text;
                }
                default -> {
                    bgc = Theme.mix(new Color(0, 0, 0, 0), t.hover, h);
                    fg = t.text;
                }
            }
            if (!en) {
                bgc = t.surface2;
                fg = t.faint;
            }
            int arc = t.px(10);
            g.setColor(bgc);
            g.fillRoundRect(0, 0, getWidth(), getHeight(), arc, arc);
            if (kind == Kind.SECONDARY) {
                g.setColor(t.border);
                g.drawRoundRect(0, 0, getWidth() - 1, getHeight() - 1, arc, arc);
            }
            g.setFont(getFont());
            FontMetrics fm = g.getFontMetrics();
            int tx = (getWidth() - fm.stringWidth(getText()) + (icon == null ? 0 : t.px(18))) / 2;
            int ty = (getHeight() + fm.getAscent() - fm.getDescent()) / 2;
            if (icon != null) {
                Ui.icon(g, icon, tx - t.px(22), getHeight() / 2 - t.px(8), t.px(16), fg);
            }
            g.setColor(fg);
            g.drawString(getText(), tx, ty);
            g.dispose();
        }
    }

    /** Rounded status chip, e.g. PASS / FAIL / DONE. */
    static JComponent pill(String text, Color fg, Color bgc) {
        JLabel l = new JLabel(text) {
            private static final long serialVersionUID = 1L;

            @Override
            protected void paintComponent(Graphics g0) {
                Graphics2D g = (Graphics2D) g0.create();
                hints(g);
                g.setColor(bgc);
                g.fillRoundRect(0, 0, getWidth(), getHeight(), getHeight(), getHeight());
                g.dispose();
                super.paintComponent(g0);
            }
        };
        l.setFont(t.size(11.5f, Font.BOLD));
        l.setForeground(fg);
        l.setBorder(BorderFactory.createEmptyBorder(t.px(3), t.px(10), t.px(3), t.px(10)));
        l.setHorizontalAlignment(JLabel.CENTER);
        return l;
    }

    static JComponent status(String s) {
        return pill(s, t.status(s), t.statusSoft(s));
    }

    /* ------------------------------------------------------------ icons (drawn, no font or image files) */

    static void icon(Graphics2D g0, String name, int x, int y, int s, Color c) {
        Graphics2D g = (Graphics2D) g0.create();
        hints(g);
        g.translate(x, y);
        g.setColor(c);
        g.setStroke(new BasicStroke(Math.max(1.4f, s / 11f), BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
        float u = s / 16f;
        switch (name) {
            case "home" -> {
                Path2D p = new Path2D.Float();
                p.moveTo(2 * u, 7.5 * u);
                p.lineTo(8 * u, 2.5 * u);
                p.lineTo(14 * u, 7.5 * u);
                p.moveTo(3.5 * u, 6.5 * u);
                p.lineTo(3.5 * u, 14 * u);
                p.lineTo(12.5 * u, 14 * u);
                p.lineTo(12.5 * u, 6.5 * u);
                g.draw(p);
            }
            case "runs" -> {
                for (int i = 0; i < 3; i++) {
                    g.fillOval(Math.round(2 * u), Math.round((3 + i * 4.5f) * u), Math.round(2.4f * u), Math.round(2.4f * u));
                    g.drawLine(Math.round(6 * u), Math.round((4.2f + i * 4.5f) * u), Math.round(14 * u), Math.round((4.2f + i * 4.5f) * u));
                }
            }
            case "wave" -> {
                Path2D p = new Path2D.Float();
                p.moveTo(1.5 * u, 9 * u);
                p.curveTo(4 * u, 1 * u, 6 * u, 1 * u, 8 * u, 8 * u);
                p.curveTo(10 * u, 15 * u, 12 * u, 15 * u, 14.5 * u, 7 * u);
                g.draw(p);
            }
            case "check" -> {
                g.drawRoundRect(Math.round(2 * u), Math.round(2 * u), Math.round(12 * u), Math.round(12 * u), Math.round(3 * u), Math.round(3 * u));
                Path2D p = new Path2D.Float();
                p.moveTo(5 * u, 8.2 * u);
                p.lineTo(7.2 * u, 10.4 * u);
                p.lineTo(11 * u, 5.8 * u);
                g.draw(p);
            }
            case "shield" -> {
                Path2D p = new Path2D.Float();
                p.moveTo(8 * u, 1.8 * u);
                p.lineTo(13.5 * u, 4 * u);
                p.curveTo(13.5 * u, 10 * u, 11 * u, 13 * u, 8 * u, 14.5 * u);
                p.curveTo(5 * u, 13 * u, 2.5 * u, 10 * u, 2.5 * u, 4 * u);
                p.closePath();
                g.draw(p);
            }
            case "memory" -> {
                g.drawRoundRect(Math.round(3 * u), Math.round(3 * u), Math.round(10 * u), Math.round(10 * u), Math.round(2 * u), Math.round(2 * u));
                for (int i = 0; i < 3; i++) {
                    int k = Math.round((5 + i * 3) * u);
                    g.drawLine(k, Math.round(1 * u), k, Math.round(3 * u));
                    g.drawLine(k, Math.round(13 * u), k, Math.round(15 * u));
                }
            }
            case "book" -> {
                Path2D p = new Path2D.Float();
                p.moveTo(8 * u, 4 * u);
                p.curveTo(6 * u, 2.5 * u, 3.5 * u, 2.5 * u, 2 * u, 3 * u);
                p.lineTo(2 * u, 13 * u);
                p.curveTo(3.5 * u, 12.5 * u, 6 * u, 12.5 * u, 8 * u, 14 * u);
                p.curveTo(10 * u, 12.5 * u, 12.5 * u, 12.5 * u, 14 * u, 13 * u);
                p.lineTo(14 * u, 3 * u);
                p.curveTo(12.5 * u, 2.5 * u, 10 * u, 2.5 * u, 8 * u, 4 * u);
                p.lineTo(8 * u, 14 * u);
                g.draw(p);
            }
            case "gear" -> {
                int cx = Math.round(8 * u);
                int r1 = Math.round(2.3f * u);
                g.drawOval(cx - r1, cx - r1, 2 * r1, 2 * r1);
                for (int i = 0; i < 8; i++) {
                    double a = i * Math.PI / 4;
                    g.drawLine((int) (cx + Math.cos(a) * 4.6 * u), (int) (cx + Math.sin(a) * 4.6 * u),
                            (int) (cx + Math.cos(a) * 6.6 * u), (int) (cx + Math.sin(a) * 6.6 * u));
                }
                g.drawOval(Math.round(3.4f * u), Math.round(3.4f * u), Math.round(9.2f * u), Math.round(9.2f * u));
            }
            case "play" -> {
                Path2D p = new Path2D.Float();
                p.moveTo(4.5 * u, 2.5 * u);
                p.lineTo(13 * u, 8 * u);
                p.lineTo(4.5 * u, 13.5 * u);
                p.closePath();
                g.fill(p);
            }
            case "bolt" -> {
                Path2D p = new Path2D.Float();
                p.moveTo(9 * u, 1.5 * u);
                p.lineTo(3.5 * u, 9 * u);
                p.lineTo(8 * u, 9 * u);
                p.lineTo(7 * u, 14.5 * u);
                p.lineTo(12.5 * u, 7 * u);
                p.lineTo(8 * u, 7 * u);
                p.closePath();
                g.fill(p);
            }
            case "search" -> {
                g.drawOval(Math.round(2 * u), Math.round(2 * u), Math.round(9 * u), Math.round(9 * u));
                g.drawLine(Math.round(9.8f * u), Math.round(9.8f * u), Math.round(14 * u), Math.round(14 * u));
            }
            case "sun" -> {
                int cx = Math.round(8 * u);
                int r1 = Math.round(3 * u);
                g.drawOval(cx - r1, cx - r1, 2 * r1, 2 * r1);
                for (int i = 0; i < 8; i++) {
                    double a = i * Math.PI / 4;
                    g.drawLine((int) (cx + Math.cos(a) * 5 * u), (int) (cx + Math.sin(a) * 5 * u),
                            (int) (cx + Math.cos(a) * 7 * u), (int) (cx + Math.sin(a) * 7 * u));
                }
            }
            case "moon" -> {
                Path2D p = new Path2D.Float();
                p.moveTo(11 * u, 2.5 * u);
                p.curveTo(5 * u, 2.5 * u, 3 * u, 11 * u, 8.5 * u, 13.5 * u);
                p.curveTo(11.5 * u, 14.5 * u, 14 * u, 12.5 * u, 14.5 * u, 10 * u);
                p.curveTo(10 * u, 11 * u, 7.5 * u, 6.5 * u, 11 * u, 2.5 * u);
                g.draw(p);
            }
            case "spark" -> {
                Path2D p = new Path2D.Float();
                p.moveTo(8 * u, 1.5 * u);
                p.curveTo(8.6 * u, 6 * u, 10 * u, 7.4 * u, 14.5 * u, 8 * u);
                p.curveTo(10 * u, 8.6 * u, 8.6 * u, 10 * u, 8 * u, 14.5 * u);
                p.curveTo(7.4 * u, 10 * u, 6 * u, 8.6 * u, 1.5 * u, 8 * u);
                p.curveTo(6 * u, 7.4 * u, 7.4 * u, 6 * u, 8 * u, 1.5 * u);
                g.fill(p);
            }
            default -> g.drawOval(Math.round(3 * u), Math.round(3 * u), Math.round(10 * u), Math.round(10 * u));
        }
        g.dispose();
    }

    /** A panel that fades its content in when shown (page transitions). */
    static final class Fade extends JPanel {
        private static final long serialVersionUID = 1L;
        private final transient Anim a;

        Fade(Component content) {
            super(new BorderLayout());
            setOpaque(false);
            add(content, BorderLayout.CENTER);
            a = new Anim(this, reduceMotion ? 1f : 0f);
            a.to(1f);
        }

        @Override
        public void paint(Graphics g0) {
            Graphics2D g = (Graphics2D) g0.create();
            g.setComposite(AlphaComposite.getInstance(AlphaComposite.SRC_OVER, Math.max(0f, Math.min(1f, a.value))));
            g.translate(0, Math.round((1f - a.value) * t.px(10)));
            super.paint(g);
            g.dispose();
        }
    }
}
