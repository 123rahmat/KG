package kg.app;

import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Cursor;
import java.awt.Dimension;
import java.awt.Font;
import java.awt.FontMetrics;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.Rectangle;
import java.awt.event.KeyEvent;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.awt.geom.Rectangle2D;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.BiConsumer;
import javax.swing.AbstractAction;
import javax.swing.JComponent;
import javax.swing.JTextPane;
import javax.swing.KeyStroke;
import javax.swing.Timer;
import javax.swing.event.DocumentEvent;
import javax.swing.event.DocumentListener;
import javax.swing.text.AbstractDocument;
import javax.swing.text.BadLocationException;
import javax.swing.text.DefaultStyledDocument;
import javax.swing.text.Element;
import javax.swing.text.SimpleAttributeSet;
import javax.swing.text.StyleConstants;
import javax.swing.undo.UndoManager;

/**
 * Code editor: C colouring, line numbers, markers in the gutter, a wavy underline and the message
 * at the end of each marked line (red error, amber warning, grey info, accent for assistant
 * suggestions), undo/redo, and tab as four spaces.
 */
final class CodeEditor extends JTextPane {
    private static final long serialVersionUID = 1L;
    private static final Set<String> KEYWORDS = Set.of("auto", "break", "case", "char", "const", "continue", "default", "do",
            "double", "else", "enum", "extern", "float", "for", "goto", "if", "inline", "int", "long", "register", "restrict",
            "return", "short", "signed", "sizeof", "static", "struct", "switch", "typedef", "union", "unsigned", "void",
            "volatile", "while", "_Bool", "_Static_assert", "bool", "true", "false", "NULL");
    private static final Set<String> TYPES = Set.of("uint8_t", "uint16_t", "uint32_t", "uint64_t", "int8_t", "int16_t",
            "int32_t", "int64_t", "size_t", "uintptr_t", "intptr_t", "float32_t");

    private final transient Map<Integer, List<Diagnostics.Diag>> byLine = new HashMap<>();
    private final transient Set<Integer> changed = new HashSet<>();
    private final transient UndoManager undo = new UndoManager();
    private final Timer recolour;
    private transient Runnable onEdit;
    private boolean loading;
    private final boolean colour;
    /** A completion offered at a position, shown in grey until Tab accepts it or Esc / typing dismisses it. */
    private String ghost;
    private int ghostAt = -1;

    CodeEditor(boolean cColouring) {
        super(new DefaultStyledDocument());
        this.colour = cColouring;
        Theme t = Ui.t;
        setFont(t.mono.deriveFont(13.5f * t.scale));
        setBackground(t.surface);
        setForeground(t.text);
        setCaretColor(t.accent);
        setSelectionColor(t.accentSoft);
        setBorder(javax.swing.BorderFactory.createEmptyBorder(t.px(8), t.px(10), t.px(40), t.px(10)));
        recolour = new Timer(150, e -> colourise());
        recolour.setRepeats(false);
        getDocument().addDocumentListener(new DocumentListener() {
            @Override
            public void insertUpdate(DocumentEvent e) {
                edited();
            }

            @Override
            public void removeUpdate(DocumentEvent e) {
                edited();
            }

            @Override
            public void changedUpdate(DocumentEvent e) {
                // attribute changes from colouring
            }
        });
        getDocument().addUndoableEditListener(e -> {
            if (e.getEdit() instanceof AbstractDocument.DefaultDocumentEvent de && de.getType() != DocumentEvent.EventType.CHANGE
                    && !loading) {
                undo.addEdit(e.getEdit());
            }
        });
        bind("ctrl Z", () -> {
            if (undo.canUndo()) {
                undo.undo();
            }
        });
        bind("ctrl Y", () -> {
            if (undo.canRedo()) {
                undo.redo();
            }
        });
        bind("ctrl shift Z", () -> {
            if (undo.canRedo()) {
                undo.redo();
            }
        });
        bind("TAB", () -> {
            if (ghost != null && ghostAt == getCaretPosition()) {
                String g = ghost;
                clearGhost();
                replaceSelection(g);
            } else {
                replaceSelection("    ");
            }
        });
        bind("ESCAPE", this::clearGhost);
        setToolTipText("");
    }

    private void bind(String key, Runnable r) {
        KeyStroke ks = KeyStroke.getKeyStroke(key.replace("ctrl", java.awt.Toolkit.getDefaultToolkit().getMenuShortcutKeyMaskEx()
                == java.awt.event.InputEvent.META_DOWN_MASK ? "meta" : "ctrl"));
        getInputMap().put(ks, key);
        getActionMap().put(key, new AbstractAction() {
            private static final long serialVersionUID = 1L;

            @Override
            public void actionPerformed(java.awt.event.ActionEvent e) {
                r.run();
            }
        });
    }

    void onEdit(Runnable r) {
        onEdit = r;
    }

    void showGhost(String text, int at) {
        ghost = text == null || text.isEmpty() ? null : text;
        ghostAt = at;
        repaint();
    }

    void clearGhost() {
        if (ghost != null) {
            ghost = null;
            ghostAt = -1;
            repaint();
        }
    }

    boolean hasGhost() {
        return ghost != null;
    }

    private void edited() {
        if (loading) {
            return;
        }
        clearGhost();
        recolour.restart();
        if (onEdit != null) {
            onEdit.run();
        }
    }

    /** Replaces the whole text (opening a file); clears undo history. */
    void load(String text) {
        loading = true;
        try {
            setText(text);
            setCaretPosition(0);
        } finally {
            loading = false;
        }
        undo.discardAllEdits();
        changed.clear();
        colourise();
    }

    void markChanged(Set<Integer> lines) {
        changed.clear();
        changed.addAll(lines);
        repaint();
    }

    void setDiags(List<Diagnostics.Diag> diags) {
        byLine.clear();
        for (Diagnostics.Diag d : diags) {
            byLine.computeIfAbsent(d.line(), k -> new ArrayList<>()).add(d);
        }
        repaint();
        if (getParent() != null && getParent().getParent() instanceof javax.swing.JScrollPane sp && sp.getRowHeader() != null) {
            sp.getRowHeader().repaint();
        }
    }

    List<Diagnostics.Diag> diagsAt(int line) {
        return byLine.getOrDefault(line, List.of());
    }

    int lineCount() {
        return getDocument().getDefaultRootElement().getElementCount();
    }

    void goToLine(int line) {
        Element root = getDocument().getDefaultRootElement();
        int l = Math.max(1, Math.min(line, root.getElementCount()));
        int off = root.getElement(l - 1).getStartOffset();
        setCaretPosition(off);
        try {
            Rectangle2D r = modelToView2D(off);
            if (r != null) {
                scrollRectToVisible(new Rectangle((int) r.getX(), (int) r.getY() - getHeight() / 3, 10, getHeight() / 2));
            }
        } catch (BadLocationException e) {
            // line is valid
        }
        requestFocusInWindow();
    }

    /** Line under a y coordinate, 1-based. */
    int lineAt(int y) {
        int off = viewToModel2D(new java.awt.Point(5, y));
        return getDocument().getDefaultRootElement().getElementIndex(Math.max(0, off)) + 1;
    }

    // No line wrapping: code keeps its layout and scrolls sideways.
    @Override
    public boolean getScrollableTracksViewportWidth() {
        return getParent() == null || getUI().getPreferredSize(this).width <= getParent().getSize().width;
    }

    static Color colourOf(Diagnostics.Sev s) {
        Theme t = Ui.t;
        return switch (s) {
            case ERROR -> t.fail;
            case WARNING -> t.warn;
            case INFO -> t.faint;
            case SUGGEST -> t.accent;
        };
    }

    private static Diagnostics.Diag worst(List<Diagnostics.Diag> l) {
        Diagnostics.Diag w = l.get(0);
        for (Diagnostics.Diag d : l) {
            if (d.sev().ordinal() < w.sev().ordinal()) {
                w = d;
            }
        }
        return w;
    }

    @Override
    protected void paintComponent(Graphics g0) {
        super.paintComponent(g0);
        Graphics2D g = (Graphics2D) g0.create();
        Ui.hints(g);
        Theme t = Ui.t;
        if (ghost != null && ghostAt >= 0 && ghostAt <= getDocument().getLength()) {
            try {
                Rectangle2D at = modelToView2D(ghostAt);
                Rectangle2D lineStart = modelToView2D(getDocument().getDefaultRootElement()
                        .getElement(getDocument().getDefaultRootElement().getElementIndex(ghostAt)).getStartOffset());
                g.setFont(getFont().deriveFont(Font.ITALIC));
                FontMetrics gm = g.getFontMetrics();
                g.setColor(Theme.mix(getBackground(), t.text, 0.42f));
                String[] gl = ghost.split("\n", -1);
                double y = at.getY() + gm.getAscent() + (at.getHeight() - gm.getHeight()) / 2;
                for (int i = 0; i < gl.length; i++) {
                    double x = i == 0 ? at.getX() : lineStart.getX();
                    g.drawString(gl[i].replace("\t", "    "), (float) x, (float) (y + i * at.getHeight()));
                }
                g.setFont(getFont().deriveFont(getFont().getSize2D() * 0.8f));
                g.setColor(t.accent);
                g.drawString("Tab to accept, Esc to dismiss", (float) (at.getX() + gm.stringWidth(gl[0]) + t.px(16)), (float) y);
            } catch (BadLocationException e) {
                // position vanished; the ghost is cleared on the next edit
            }
        }
        Element root = getDocument().getDefaultRootElement();
        Font small = getFont().deriveFont(Font.ITALIC, getFont().getSize2D() * 0.9f);
        g.setFont(small);
        FontMetrics fm = g.getFontMetrics();
        Rectangle clip = g.getClipBounds();
        for (Map.Entry<Integer, List<Diagnostics.Diag>> e : byLine.entrySet()) {
            int line = e.getKey();
            if (line < 1 || line > root.getElementCount()) {
                continue;
            }
            Element el = root.getElement(line - 1);
            try {
                int start = el.getStartOffset();
                int end = Math.max(start, el.getEndOffset() - 1);
                String text = getDocument().getText(start, end - start);
                int lead = 0;
                while (lead < text.length() && Character.isWhitespace(text.charAt(lead))) {
                    lead++;
                }
                Rectangle2D a = modelToView2D(start + lead);
                Rectangle2D b = modelToView2D(end);
                if (a == null || b == null || (clip != null && (b.getMaxY() < clip.y || a.getY() > clip.getMaxY()))) {
                    continue;
                }
                Diagnostics.Diag w = worst(e.getValue());
                Color c = colourOf(w.sev());
                // wavy underline under the code on that line
                if (w.sev() != Diagnostics.Sev.INFO && b.getX() > a.getX()) {
                    g.setColor(c);
                    g.setStroke(new BasicStroke(Math.max(1f, t.scale)));
                    int y = (int) (a.getMaxY()) - 1;
                    int step = t.px(3);
                    for (int x = (int) a.getX(); x < (int) b.getX(); x += step * 2) {
                        g.drawLine(x, y, x + step, y - step / 2 - 1);
                        g.drawLine(x + step, y - step / 2 - 1, Math.min(x + step * 2, (int) b.getX()), y);
                    }
                } else if (w.sev() == Diagnostics.Sev.INFO) {
                    g.setColor(Theme.mix(getBackground(), t.faint, 0.16f));
                    g.fillRect(0, (int) a.getY(), getWidth(), (int) a.getHeight());
                }
                // message after the end of the line
                String msg = w.text() + (e.getValue().size() > 1 ? "  (+" + (e.getValue().size() - 1) + " more)" : "");
                if (msg.length() > 140) {
                    msg = msg.substring(0, 137) + "...";
                }
                int x = (int) b.getX() + t.px(28);
                int y = (int) (b.getY() + (b.getHeight() + fm.getAscent() - fm.getDescent()) / 2);
                int w2 = fm.stringWidth(msg) + t.px(14);
                g.setColor(Theme.mix(getBackground(), c, 0.12f));
                g.fillRoundRect(x - t.px(7), (int) b.getY() + 1, w2, (int) b.getHeight() - 2, t.px(8), t.px(8));
                g.setColor(Theme.mix(getBackground(), c, 0.95f));
                g.drawString(msg, x, y);
            } catch (BadLocationException ex) {
                // line vanished during an edit; repainted next frame
            }
        }
        g.dispose();
    }

    @Override
    public String getToolTipText(MouseEvent e) {
        List<Diagnostics.Diag> l = diagsAt(lineAt(e.getY()));
        if (l.isEmpty()) {
            return null;
        }
        StringBuilder sb = new StringBuilder("<html>");
        for (Diagnostics.Diag d : l) {
            sb.append("<b>").append(App.esc(d.source())).append(":</b> ").append(App.esc(d.text())).append("<br>");
        }
        return sb.append("</html>").toString();
    }

    /* ------------------------------------------------------------ syntax colouring */

    private void colourise() {
        if (!colour) {
            return;
        }
        Theme t = Ui.t;
        DefaultStyledDocument doc = (DefaultStyledDocument) getDocument();
        String s;
        try {
            s = doc.getText(0, doc.getLength());
        } catch (BadLocationException e) {
            return;
        }
        SimpleAttributeSet plain = attr(t.text, false, false);
        SimpleAttributeSet kw = attr(t.dark ? new Color(0xC792EA) : new Color(0x7B2FBF), true, false);
        SimpleAttributeSet ty = attr(t.dark ? new Color(0x82AAFF) : new Color(0x1F5FBF), false, false);
        SimpleAttributeSet num = attr(t.dark ? new Color(0xF78C6C) : new Color(0xB4501E), false, false);
        SimpleAttributeSet str = attr(t.dark ? new Color(0xC3E88D) : new Color(0x2E7D32), false, false);
        SimpleAttributeSet com = attr(t.muted, false, true);
        SimpleAttributeSet pre = attr(t.dark ? new Color(0x89DDFF) : new Color(0x00796B), false, false);
        SimpleAttributeSet fn = attr(t.dark ? new Color(0xFFCB6B) : new Color(0x9A6700), false, false);
        doc.setCharacterAttributes(0, s.length(), plain, true);
        int n = s.length();
        int i = 0;
        boolean lineStart = true;
        while (i < n) {
            char c = s.charAt(i);
            if (c == '\n') {
                lineStart = true;
                i++;
                continue;
            }
            if (lineStart && c == '#') {
                int e = s.indexOf('\n', i);
                e = e < 0 ? n : e;
                doc.setCharacterAttributes(i, e - i, pre, true);
                i = e;
                continue;
            }
            if (!Character.isWhitespace(c)) {
                lineStart = false;
            }
            if (c == '/' && i + 1 < n && s.charAt(i + 1) == '/') {
                int e = s.indexOf('\n', i);
                e = e < 0 ? n : e;
                doc.setCharacterAttributes(i, e - i, com, true);
                i = e;
            } else if (c == '/' && i + 1 < n && s.charAt(i + 1) == '*') {
                int e = s.indexOf("*/", i + 2);
                e = e < 0 ? n : e + 2;
                doc.setCharacterAttributes(i, e - i, com, true);
                i = e;
            } else if (c == '"' || c == '\'') {
                int e = i + 1;
                while (e < n && s.charAt(e) != c && s.charAt(e) != '\n') {
                    e += s.charAt(e) == '\\' ? 2 : 1;
                }
                e = Math.min(n, e + 1);
                doc.setCharacterAttributes(i, e - i, str, true);
                i = e;
            } else if (Character.isDigit(c)) {
                int e = i;
                while (e < n && (Character.isLetterOrDigit(s.charAt(e)) || s.charAt(e) == '.')) {
                    e++;
                }
                doc.setCharacterAttributes(i, e - i, num, true);
                i = e;
            } else if (Character.isLetter(c) || c == '_') {
                int e = i;
                while (e < n && (Character.isLetterOrDigit(s.charAt(e)) || s.charAt(e) == '_')) {
                    e++;
                }
                String id = s.substring(i, e);
                int k = e;
                while (k < n && s.charAt(k) == ' ') {
                    k++;
                }
                if (KEYWORDS.contains(id)) {
                    doc.setCharacterAttributes(i, e - i, kw, true);
                } else if (TYPES.contains(id)) {
                    doc.setCharacterAttributes(i, e - i, ty, true);
                } else if (k < n && s.charAt(k) == '(') {
                    doc.setCharacterAttributes(i, e - i, fn, true);
                }
                i = e;
            } else {
                i++;
            }
        }
    }

    private SimpleAttributeSet attr(Color c, boolean bold, boolean italic) {
        SimpleAttributeSet a = new SimpleAttributeSet();
        StyleConstants.setForeground(a, c);
        StyleConstants.setBold(a, bold);
        StyleConstants.setItalic(a, italic);
        StyleConstants.setFontFamily(a, getFont().getFamily());
        StyleConstants.setFontSize(a, getFont().getSize());
        return a;
    }

    /* ------------------------------------------------------------ gutter */

    /** Line numbers and marker dots; clicking a dot reports (line, markers). */
    static final class Gutter extends JComponent {
        private static final long serialVersionUID = 1L;
        private final CodeEditor ed;

        Gutter(CodeEditor ed, BiConsumer<Integer, List<Diagnostics.Diag>> onClick) {
            this.ed = ed;
            setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
            setToolTipText("");
            addMouseListener(new MouseAdapter() {
                @Override
                public void mouseClicked(MouseEvent e) {
                    int line = ed.lineAt(e.getY());
                    List<Diagnostics.Diag> l = ed.diagsAt(line);
                    if (!l.isEmpty()) {
                        onClick.accept(line, l);
                    }
                }
            });
            ed.getDocument().addDocumentListener(new DocumentListener() {
                @Override
                public void insertUpdate(DocumentEvent e) {
                    repaint();
                }

                @Override
                public void removeUpdate(DocumentEvent e) {
                    repaint();
                }

                @Override
                public void changedUpdate(DocumentEvent e) {
                    // nothing
                }
            });
        }

        @Override
        public String getToolTipText(MouseEvent e) {
            List<Diagnostics.Diag> l = ed.diagsAt(ed.lineAt(e.getY()));
            return l.isEmpty() ? null : "<html>" + App.esc(l.get(0).text()) + "<br><i>Click to ask the assistant</i></html>";
        }

        @Override
        public Dimension getPreferredSize() {
            FontMetrics fm = getFontMetrics(ed.getFont());
            int digits = Math.max(3, String.valueOf(ed.lineCount()).length());
            return new Dimension(fm.charWidth('0') * digits + Ui.t.px(30), ed.getPreferredSize().height);
        }

        @Override
        protected void paintComponent(Graphics g0) {
            Theme t = Ui.t;
            Graphics2D g = (Graphics2D) g0.create();
            Ui.hints(g);
            g.setColor(t.surface);
            g.fillRect(0, 0, getWidth(), getHeight());
            g.setFont(ed.getFont().deriveFont(ed.getFont().getSize2D() * 0.85f));
            FontMetrics fm = g.getFontMetrics();
            Element root = ed.getDocument().getDefaultRootElement();
            Rectangle clip = g.getClipBounds();
            int caretLine = root.getElementIndex(ed.getCaretPosition()) + 1;
            for (int i = 0; i < root.getElementCount(); i++) {
                try {
                    Rectangle2D r = ed.modelToView2D(root.getElement(i).getStartOffset());
                    if (r == null || (clip != null && (r.getMaxY() < clip.y || r.getY() > clip.getMaxY()))) {
                        continue;
                    }
                    int line = i + 1;
                    String num = String.valueOf(line);
                    int y = (int) (r.getY() + (r.getHeight() + fm.getAscent() - fm.getDescent()) / 2);
                    g.setColor(line == caretLine ? t.text : t.faint);
                    g.drawString(num, getWidth() - t.px(10) - fm.stringWidth(num), y);
                    if (ed.changed.contains(line)) {
                        g.setColor(t.pass);
                        g.fillRect(getWidth() - t.px(3), (int) r.getY(), t.px(3), (int) r.getHeight());
                    }
                    List<Diagnostics.Diag> l = ed.diagsAt(line);
                    if (!l.isEmpty()) {
                        g.setColor(colourOf(worst(l).sev()));
                        int d = t.px(8);
                        g.fillOval(t.px(6), (int) (r.getY() + (r.getHeight() - d) / 2), d, d);
                    }
                } catch (BadLocationException e) {
                    // skip
                }
            }
            g.setColor(t.border);
            g.drawLine(getWidth() - 1, 0, getWidth() - 1, getHeight());
            g.dispose();
        }
    }

    static KeyStroke save() {
        return KeyStroke.getKeyStroke(KeyEvent.VK_S, java.awt.Toolkit.getDefaultToolkit().getMenuShortcutKeyMaskEx());
    }
}
