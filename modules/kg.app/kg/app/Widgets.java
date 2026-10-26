package kg.app;

import java.awt.Color;
import java.awt.Cursor;
import java.awt.Dimension;
import java.awt.Font;
import java.awt.FontMetrics;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import javax.swing.JComponent;

/** Toggle switch, segmented control and sidebar navigation item, all custom painted and animated. */
final class Widgets {
    private Widgets() {
    }

    static final class Switch extends JComponent {
        private static final long serialVersionUID = 1L;
        private boolean on;
        private final transient Ui.Anim knob;
        private final transient List<Consumer<Boolean>> listeners = new ArrayList<>();

        Switch(boolean initial) {
            on = initial;
            knob = new Ui.Anim(this, initial ? 1f : 0f);
            setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
            addMouseListener(new MouseAdapter() {
                @Override
                public void mouseClicked(MouseEvent e) {
                    if (isEnabled()) {
                        set(!on);
                        listeners.forEach(l -> l.accept(on));
                    }
                }
            });
        }

        void onChange(Consumer<Boolean> l) {
            listeners.add(l);
        }

        boolean isOn() {
            return on;
        }

        void set(boolean v) {
            on = v;
            knob.to(v ? 1f : 0f);
        }

        @Override
        public Dimension getPreferredSize() {
            return new Dimension(Ui.t.px(40), Ui.t.px(22));
        }

        @Override
        public Dimension getMaximumSize() {
            return getPreferredSize();
        }

        @Override
        protected void paintComponent(Graphics g0) {
            Theme t = Ui.t;
            Graphics2D g = (Graphics2D) g0.create();
            Ui.hints(g);
            int w = getWidth();
            int h = getHeight();
            g.setColor(isEnabled() ? Theme.mix(t.border, t.accent, knob.value) : t.surface2);
            g.fillRoundRect(0, 0, w, h, h, h);
            int d = h - t.px(6);
            int x = t.px(3) + Math.round((w - d - t.px(6)) * knob.value);
            g.setColor(isEnabled() ? Color.WHITE : t.faint);
            g.fillOval(x, t.px(3), d, d);
            g.dispose();
        }
    }

    /** A row of options where exactly one is selected (e.g. SIL | PIL | HIL). */
    static final class Segmented extends JComponent {
        private static final long serialVersionUID = 1L;
        private final String[] options;
        private int selected;
        private final transient Ui.Anim pos;
        private final transient List<Consumer<String>> listeners = new ArrayList<>();

        Segmented(String[] options, String initial) {
            this.options = options.clone();
            for (int i = 0; i < options.length; i++) {
                if (options[i].equalsIgnoreCase(initial)) {
                    selected = i;
                }
            }
            pos = new Ui.Anim(this, selected);
            setFont(Ui.t.size(12.5f, Font.BOLD));
            setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
            addMouseListener(new MouseAdapter() {
                @Override
                public void mouseClicked(MouseEvent e) {
                    int i = Math.min(Segmented.this.options.length - 1, Math.max(0, e.getX() * Segmented.this.options.length / getWidth()));
                    select(i);
                    listeners.forEach(l -> l.accept(value()));
                }
            });
        }

        void onChange(Consumer<String> l) {
            listeners.add(l);
        }

        String value() {
            return options[selected];
        }

        void select(int i) {
            selected = i;
            pos.to(i);
        }

        @Override
        public Dimension getPreferredSize() {
            FontMetrics fm = getFontMetrics(getFont());
            int w = 0;
            for (String o : options) {
                w = Math.max(w, fm.stringWidth(o));
            }
            return new Dimension((w + Ui.t.px(26)) * options.length, Ui.t.px(34));
        }

        @Override
        public Dimension getMaximumSize() {
            return getPreferredSize();
        }

        @Override
        protected void paintComponent(Graphics g0) {
            Theme t = Ui.t;
            Graphics2D g = (Graphics2D) g0.create();
            Ui.hints(g);
            int w = getWidth();
            int h = getHeight();
            int seg = w / options.length;
            g.setColor(t.surface2);
            g.fillRoundRect(0, 0, w, h, t.px(10), t.px(10));
            g.setColor(t.border);
            g.drawRoundRect(0, 0, w - 1, h - 1, t.px(10), t.px(10));
            g.setColor(t.surface);
            int x = Math.round(pos.value * seg) + t.px(3);
            g.fillRoundRect(x, t.px(3), seg - t.px(6), h - t.px(6), t.px(8), t.px(8));
            g.setFont(getFont());
            FontMetrics fm = g.getFontMetrics();
            for (int i = 0; i < options.length; i++) {
                g.setColor(i == selected ? t.text : t.muted);
                int tx = i * seg + (seg - fm.stringWidth(options[i])) / 2;
                g.drawString(options[i], tx, (h + fm.getAscent() - fm.getDescent()) / 2);
            }
            g.dispose();
        }
    }

    /** Sidebar entry with an icon, hover glow and an animated selection bar. */
    static final class NavItem extends JComponent {
        private static final long serialVersionUID = 1L;
        final String label;
        private final String icon;
        private final transient Ui.Anim hover;
        private final transient Ui.Anim sel;
        private String badge;
        private boolean compact;

        /** Icon only (used for the page rail on the Code page); the label becomes a tooltip. */
        void compact(boolean c) {
            compact = c;
            setToolTipText(c ? label : null);
            revalidate();
            repaint();
        }

        NavItem(String label, String icon, Runnable onClick) {
            this.label = label;
            this.icon = icon;
            hover = new Ui.Anim(this, 0f);
            sel = new Ui.Anim(this, 0f);
            setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
            addMouseListener(new MouseAdapter() {
                @Override
                public void mouseEntered(MouseEvent e) {
                    hover.to(1f);
                }

                @Override
                public void mouseExited(MouseEvent e) {
                    hover.to(0f);
                }

                @Override
                public void mouseClicked(MouseEvent e) {
                    onClick.run();
                }
            });
        }

        void selected(boolean s) {
            sel.to(s ? 1f : 0f);
        }

        void badge(String b) {
            badge = b;
            repaint();
        }

        @Override
        public Dimension getPreferredSize() {
            return new Dimension(Ui.t.px(compact ? 56 : 160), Ui.t.px(38));
        }

        @Override
        public Dimension getMaximumSize() {
            return new Dimension(Integer.MAX_VALUE, Ui.t.px(38));
        }

        @Override
        protected void paintComponent(Graphics g0) {
            Theme t = Ui.t;
            Graphics2D g = (Graphics2D) g0.create();
            Ui.hints(g);
            float s = sel.value;
            float h = Math.max(hover.value * 0.6f, s);
            g.setColor(Theme.mix(t.sidebar, t.hover, h));
            g.fillRoundRect(t.px(8), t.px(2), getWidth() - t.px(16), getHeight() - t.px(4), t.px(10), t.px(10));
            if (s > 0.01f) {
                g.setColor(t.accent);
                int bh = Math.round((getHeight() - t.px(18)) * s);
                g.fillRoundRect(t.px(8), (getHeight() - bh) / 2, t.px(3), bh, t.px(3), t.px(3));
            }
            Color fg = Theme.mix(t.muted, t.text, Math.max(s, hover.value));
            if (compact) {
                Ui.icon(g, icon, (getWidth() - t.px(16)) / 2, getHeight() / 2 - t.px(8), t.px(16), s > 0.5f ? t.accent : fg);
                if (badge != null) {
                    g.setColor(t.status(badge));
                    g.fillOval(getWidth() / 2 + t.px(6), getHeight() / 2 - t.px(10), t.px(7), t.px(7));
                }
                g.dispose();
                return;
            }
            Ui.icon(g, icon, t.px(22), getHeight() / 2 - t.px(8), t.px(16), s > 0.5f ? t.accent : fg);
            g.setFont(t.size(13.5f, s > 0.5f ? Font.BOLD : Font.PLAIN));
            g.setColor(fg);
            FontMetrics fm = g.getFontMetrics();
            g.drawString(label, t.px(48), (getHeight() + fm.getAscent() - fm.getDescent()) / 2);
            if (badge != null) {
                g.setFont(t.size(11f, Font.BOLD));
                FontMetrics bf = g.getFontMetrics();
                int bw = bf.stringWidth(badge) + t.px(12);
                int bx = getWidth() - t.px(18) - bw;
                Color bc = t.status(badge);
                g.setColor(t.statusSoft(badge));
                g.fillRoundRect(bx, getHeight() / 2 - t.px(10), bw, t.px(20), t.px(20), t.px(20));
                g.setColor(bc);
                g.drawString(badge, bx + t.px(6), getHeight() / 2 + bf.getAscent() / 2 - t.px(1));
            }
            g.dispose();
        }
    }
}
