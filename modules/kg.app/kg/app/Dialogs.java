package kg.app;

import java.awt.AlphaComposite;
import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Component;
import java.awt.Dimension;
import java.awt.Font;
import java.awt.FontMetrics;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.Window;
import java.awt.event.KeyEvent;
import javax.swing.AbstractAction;
import javax.swing.BorderFactory;
import javax.swing.JComboBox;
import javax.swing.JComponent;
import javax.swing.JDialog;
import javax.swing.JFrame;
import javax.swing.JPanel;
import javax.swing.JRootPane;
import javax.swing.JTextArea;
import javax.swing.JTextField;
import javax.swing.KeyStroke;

/**
 * The app's own dialogs: same colours and type as the rest of Kindgleam, an icon by importance,
 * a clear title, buttons that say what they do, Enter to confirm and Esc to cancel, and the window
 * behind dimmed while the dialog is open.
 */
final class Dialogs {
    enum Kind { INFO, WARNING, DANGER }

    private Dialogs() {
    }

    static boolean confirm(Window owner, Kind kind, String title, String message, String ok, String cancel) {
        return show(owner, kind, title, message, null, ok, cancel);
    }

    static void message(Window owner, Kind kind, String title, String message) {
        show(owner, kind, title, message, null, "OK", null);
    }

    /** A dialog with extra controls under the message (fields, lists). */
    static boolean form(Window owner, Kind kind, String title, String message, JComponent body, String ok, String cancel) {
        return show(owner, kind, title, message, body, ok, cancel);
    }

    /** One text field; returns null when cancelled. */
    static String input(Window owner, String title, String message, String initial, String ok) {
        JTextField f = field(initial);
        return form(owner, Kind.INFO, title, message, f, ok, "Cancel") ? f.getText().strip() : null;
    }

    static JTextField field(String text) {
        Theme t = Ui.t;
        JTextField f = new JTextField(text);
        f.setFont(t.size(13.5f, Font.PLAIN));
        f.setForeground(t.text);
        f.setBackground(t.surface2);
        f.setCaretColor(t.accent);
        f.setSelectionColor(t.accentSoft);
        f.setBorder(BorderFactory.createCompoundBorder(BorderFactory.createLineBorder(t.border),
                BorderFactory.createEmptyBorder(t.px(8), t.px(10), t.px(8), t.px(10))));
        f.setAlignmentX(Component.LEFT_ALIGNMENT);
        f.setMaximumSize(new Dimension(Integer.MAX_VALUE, f.getPreferredSize().height));
        return f;
    }

    static <T> JComboBox<T> combo(T[] items) {
        Theme t = Ui.t;
        JComboBox<T> c = new JComboBox<>(items);
        c.setFont(t.size(13.5f, Font.PLAIN));
        c.setForeground(t.text);
        c.setBackground(t.surface2);
        c.setBorder(BorderFactory.createLineBorder(t.border));
        c.setAlignmentX(Component.LEFT_ALIGNMENT);
        c.setMaximumSize(new Dimension(Integer.MAX_VALUE, Ui.t.px(36)));
        return c;
    }

    static JComponent label(String text) {
        JComponent l = Ui.label(text, 12.5f, Font.BOLD, Ui.t.muted);
        l.setBorder(BorderFactory.createEmptyBorder(Ui.t.px(10), 0, Ui.t.px(4), 0));
        l.setAlignmentX(Component.LEFT_ALIGNMENT);
        return l;
    }

    private static boolean show(Window owner, Kind kind, String title, String message, JComponent body, String ok, String cancel) {
        Theme t = Ui.t;
        JDialog d = new JDialog(owner, title, java.awt.Dialog.ModalityType.APPLICATION_MODAL);
        d.setUndecorated(true);
        boolean[] result = {false};

        Ui.Card card = new Ui.Card(t.px(16));
        card.fill = t.surface;
        card.setBorder(BorderFactory.createEmptyBorder(t.px(22), t.px(24), t.px(20), t.px(24)));
        JPanel col = Ui.column();

        JPanel head = new JPanel(new BorderLayout(t.px(14), 0));
        head.setOpaque(false);
        head.add(new Badge(kind), BorderLayout.WEST);
        JComponent tl = Ui.label(title, 17f, Font.BOLD, t.text);
        head.add(tl, BorderLayout.CENTER);
        head.setAlignmentX(Component.LEFT_ALIGNMENT);
        col.add(head);

        if (message != null && !message.isBlank()) {
            JTextArea m = new JTextArea(message);
            m.setEditable(false);
            m.setLineWrap(true);
            m.setWrapStyleWord(true);
            m.setOpaque(false);
            m.setFocusable(false);
            m.setFont(t.size(13.5f, Font.PLAIN));
            m.setForeground(t.muted);
            m.setBorder(BorderFactory.createEmptyBorder(t.px(12), t.px(46), 0, 0));
            m.setAlignmentX(Component.LEFT_ALIGNMENT);
            m.setSize(new Dimension(t.px(470), Short.MAX_VALUE));
            m.setPreferredSize(new Dimension(t.px(516), m.getPreferredSize().height));
            col.add(m);
        }
        if (body != null) {
            JPanel b = new JPanel(new BorderLayout());
            b.setOpaque(false);
            b.setBorder(BorderFactory.createEmptyBorder(t.px(10), t.px(46), 0, 0));
            b.add(body, BorderLayout.CENTER);
            b.setAlignmentX(Component.LEFT_ALIGNMENT);
            col.add(b);
        }

        JPanel buttons = new JPanel(new java.awt.FlowLayout(java.awt.FlowLayout.RIGHT, t.px(8), 0));
        buttons.setOpaque(false);
        buttons.setBorder(BorderFactory.createEmptyBorder(t.px(22), 0, 0, 0));
        Ui.Btn yes = new Ui.Btn(ok, kind == Kind.DANGER ? Ui.Kind.DANGER : Ui.Kind.PRIMARY);
        if (cancel != null) {
            Ui.Btn no = new Ui.Btn(cancel, Ui.Kind.SECONDARY);
            no.addActionListener(e -> d.dispose());
            buttons.add(no);
        }
        yes.addActionListener(e -> {
            result[0] = true;
            d.dispose();
        });
        buttons.add(yes);
        buttons.setAlignmentX(Component.LEFT_ALIGNMENT);
        col.add(buttons);
        card.add(col);

        JRootPane rp = d.getRootPane();
        rp.registerKeyboardAction(e -> d.dispose(), KeyStroke.getKeyStroke(KeyEvent.VK_ESCAPE, 0), JComponent.WHEN_IN_FOCUSED_WINDOW);
        rp.getInputMap(JComponent.WHEN_IN_FOCUSED_WINDOW).put(KeyStroke.getKeyStroke(KeyEvent.VK_ENTER, 0), "kg-ok");
        rp.getActionMap().put("kg-ok", new AbstractAction() {
            private static final long serialVersionUID = 1L;

            @Override
            public void actionPerformed(java.awt.event.ActionEvent e) {
                result[0] = true;
                d.dispose();
            }
        });
        d.setContentPane(card);
        d.setBackground(new Color(0, 0, 0, 0));
        d.pack();
        d.setSize(Math.max(d.getWidth(), t.px(600)), d.getHeight());
        d.setLocationRelativeTo(owner);

        // dim the window behind
        Component glass = null;
        if (owner instanceof JFrame f) {
            JComponent g = new JComponent() {
                private static final long serialVersionUID = 1L;

                @Override
                protected void paintComponent(Graphics g0) {
                    Graphics2D g2 = (Graphics2D) g0.create();
                    g2.setComposite(AlphaComposite.getInstance(AlphaComposite.SRC_OVER, 0.45f));
                    g2.setColor(Color.BLACK);
                    g2.fillRect(0, 0, getWidth(), getHeight());
                    g2.dispose();
                }
            };
            glass = f.getGlassPane();
            f.setGlassPane(g);
            g.setVisible(true);
        }
        d.setVisible(true);
        if (owner instanceof JFrame f && glass != null) {
            f.getGlassPane().setVisible(false);
            f.setGlassPane(glass);
        }
        return result[0];
    }

    /** Round badge with a symbol: i (information), ! (warning), x (danger). */
    private static final class Badge extends JComponent {
        private static final long serialVersionUID = 1L;
        private final Kind kind;

        Badge(Kind kind) {
            this.kind = kind;
        }

        @Override
        public Dimension getPreferredSize() {
            return new Dimension(Ui.t.px(32), Ui.t.px(32));
        }

        @Override
        protected void paintComponent(Graphics g0) {
            Theme t = Ui.t;
            Graphics2D g = (Graphics2D) g0.create();
            Ui.hints(g);
            Color c = switch (kind) {
                case INFO -> t.accent;
                case WARNING -> t.warn;
                case DANGER -> t.fail;
            };
            int s = Math.min(getWidth(), getHeight());
            g.setColor(Theme.mix(t.surface, c, 0.22f));
            g.fillOval(0, 0, s, s);
            g.setColor(c);
            g.setFont(t.size(16f, Font.BOLD));
            String sym = switch (kind) {
                case INFO -> "i";
                case WARNING -> "!";
                case DANGER -> "×";
            };
            FontMetrics fm = g.getFontMetrics();
            g.drawString(sym, (s - fm.stringWidth(sym)) / 2, (s + fm.getAscent() - fm.getDescent()) / 2);
            g.dispose();
        }
    }
}
