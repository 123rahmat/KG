package kg.app;

import java.awt.BorderLayout;
import java.awt.Component;
import java.awt.Dimension;
import java.awt.Font;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;
import javax.swing.AbstractAction;
import javax.swing.BorderFactory;
import javax.swing.JComboBox;
import javax.swing.JComponent;
import javax.swing.JLabel;
import javax.swing.JMenuItem;
import javax.swing.JPanel;
import javax.swing.JPopupMenu;
import javax.swing.JScrollPane;
import javax.swing.JTextArea;
import javax.swing.SwingUtilities;
import javax.swing.Timer;
import kg.assist.Assistant;
import kg.assist.EngineClient;
import kg.assist.Guard;
import kg.assist.ModelStore;
import kg.core.InputException;
import kg.core.SafeFiles;
import kg.gates.Requirements;

/**
 * The workspace for one project: files on the left, the editor in the middle with Kindgleam's
 * markers on the lines, the problems list below, and the assistant beside the editor. The
 * assistant reads the code and run results and suggests; the person applies or rejects.
 */
final class CodePage extends JPanel {
    private static final long serialVersionUID = 1L;

    private final transient App app;
    private final transient Path project;
    private final CodeEditor editor = new CodeEditor(true);
    private final JPanel files = Ui.column();
    private final JPanel problems = Ui.column();
    private final JLabel fileLabel = new JLabel();
    private final JLabel counts = new JLabel();
    private final JLabel liveState = Ui.muted("");
    private final JPanel assistBody = Ui.column();
    private final JTextArea stream;
    private final JLabel assistStatus = Ui.muted("");
    private final JPanel proposalBox = Ui.column();
    private final JPanel suggestBox = Ui.column();
    private final Timer liveTimer;
    private final Timer suggestTimer;
    private final transient Map<String, String> unsaved = new LinkedHashMap<>();
    private transient List<Diagnostics.Diag> live = List.of();
    private transient List<Diagnostics.Diag> fromRun = List.of();
    private transient List<Diagnostics.Diag> suggestions = new ArrayList<>();
    private transient Assistant.Proposal proposal;
    private transient Assistant running;
    private String current;
    private String lastRun;
    private boolean busy;
    private boolean assistOpen;
    private JPanel east;

    CodePage(App app) {
        super(new BorderLayout());
        this.app = app;
        this.project = app.data.project;
        this.assistOpen = app.settings.assistantEnabled;
        Theme t = Ui.t;
        setOpaque(true);
        setBackground(t.bg);
        stream = Ui.textBlock("", true);
        stream.setRows(8);
        liveTimer = new Timer(900, e -> runLive());
        liveTimer.setRepeats(false);
        suggestTimer = new Timer(700, e -> suggest());
        suggestTimer.setRepeats(false);
        editor.onEdit(() -> {
            if (current != null) {
                unsaved.put(current, editor.getText());
                updateTitle();
                if (isFirmware(current)) {
                    liveState.setText("checking...");
                    liveTimer.restart();
                    suggestTimer.restart();
                }
            }
        });
        editor.getInputMap().put(javax.swing.KeyStroke.getKeyStroke(java.awt.event.KeyEvent.VK_SPACE,
                java.awt.event.InputEvent.CTRL_DOWN_MASK), "kg-complete");
        editor.getActionMap().put("kg-complete", new AbstractAction() {
            private static final long serialVersionUID = 1L;

            @Override
            public void actionPerformed(java.awt.event.ActionEvent e) {
                complete(false);
            }
        });
        editor.getInputMap().put(CodeEditor.save(), "kg-save");
        editor.getActionMap().put("kg-save", new AbstractAction() {
            private static final long serialVersionUID = 1L;

            @Override
            public void actionPerformed(java.awt.event.ActionEvent e) {
                saveAll();
            }
        });
        build();
        List<String> fw = Assistant.firmwareFiles(project);
        open(fw.stream().filter(f -> f.endsWith(".c")).findFirst().orElse(fw.isEmpty() ? "interface.cfg" : fw.get(0)));
        runFinished(latestRun());
    }

    /* ------------------------------------------------------------ layout */

    private void build() {
        Theme t = Ui.t;
        removeAll();
        // files
        JPanel west = new JPanel(new BorderLayout());
        west.setBackground(t.bg);
        west.setPreferredSize(new Dimension(t.px(190), 10));
        west.setBorder(BorderFactory.createMatteBorder(0, 0, 0, 1, t.border));
        JPanel wtop = Ui.column();
        wtop.setBorder(BorderFactory.createEmptyBorder(t.px(12), t.px(12), t.px(6), t.px(12)));
        Ui.Btn nf = new Ui.Btn("New file", Ui.Kind.SECONDARY);
        nf.addActionListener(e -> newFile());
        wtop.add(Ui.left(nf));
        west.add(wtop, BorderLayout.NORTH);
        Pages.Fit ff = new Pages.Fit();
        ff.add(files, BorderLayout.NORTH);
        JScrollPane fs = Ui.scroll(ff);
        fs.setHorizontalScrollBarPolicy(JScrollPane.HORIZONTAL_SCROLLBAR_NEVER);
        west.add(fs, BorderLayout.CENTER);
        add(west, BorderLayout.WEST);

        // editor
        JPanel center = new JPanel(new BorderLayout());
        center.setBackground(t.surface);
        JPanel bar = new JPanel(new BorderLayout(t.px(10), 0));
        bar.setBackground(t.bg);
        bar.setBorder(BorderFactory.createCompoundBorder(BorderFactory.createMatteBorder(0, 0, 1, 0, t.border),
                BorderFactory.createEmptyBorder(t.px(8), t.px(14), t.px(8), t.px(10))));
        fileLabel.setFont(t.size(13.5f, Font.BOLD));
        fileLabel.setForeground(t.text);
        JPanel left = Ui.row(t.px(12));
        left.add(fileLabel);
        left.add(counts);
        left.add(liveState);
        bar.add(left, BorderLayout.CENTER);
        JPanel right = Ui.row(t.px(8));
        Ui.Btn save = new Ui.Btn("Save", Ui.Kind.SECONDARY);
        save.setToolTipText("Save all files (Ctrl+S)");
        save.addActionListener(e -> saveAll());
        Ui.Btn toggle = new Ui.Btn(assistOpen ? "Hide assistant" : "Assistant", Ui.Kind.GHOST, "spark");
        toggle.addActionListener(e -> {
            assistOpen = !assistOpen;
            build();
        });
        right.add(save);
        right.add(toggle);
        bar.add(right, BorderLayout.EAST);
        center.add(bar, BorderLayout.NORTH);
        JScrollPane sp = new JScrollPane(editor);
        sp.setBorder(BorderFactory.createEmptyBorder());
        sp.getViewport().setBackground(t.surface);
        sp.setRowHeaderView(new CodeEditor.Gutter(editor, this::markerMenu));
        sp.getVerticalScrollBar().setUnitIncrement(t.px(18));
        center.add(sp, BorderLayout.CENTER);
        JScrollPane ps = Ui.scroll(problems);
        ps.setPreferredSize(new Dimension(10, t.px(150)));
        ps.setBorder(BorderFactory.createMatteBorder(1, 0, 0, 0, t.border));
        center.add(ps, BorderLayout.SOUTH);
        add(center, BorderLayout.CENTER);

        // assistant
        if (assistOpen) {
            east = new JPanel(new BorderLayout());
            east.setBackground(t.bg);
            east.setPreferredSize(new Dimension(t.px(340), 10));
            east.setBorder(BorderFactory.createMatteBorder(0, 1, 0, 0, t.border));
            buildAssistant();
            Pages.Fit fit = new Pages.Fit();
            fit.add(assistBody, BorderLayout.NORTH);
            JScrollPane as = Ui.scroll(fit);
            as.setHorizontalScrollBarPolicy(JScrollPane.HORIZONTAL_SCROLLBAR_NEVER);
            east.add(as, BorderLayout.CENTER);
            add(east, BorderLayout.EAST);
        }
        refreshFiles();
        refreshProblems();
        updateTitle();
        revalidate();
        repaint();
    }

    private void refreshFiles() {
        Theme t = Ui.t;
        files.removeAll();
        files.setBorder(BorderFactory.createEmptyBorder(0, t.px(4), t.px(10), t.px(4)));
        section("FIRMWARE", Assistant.firmwareFiles(project));
        section("REQUIREMENTS", List.of("spec/spec.req"));
        List<String> vec = new ArrayList<>();
        try (Stream<Path> s = Files.list(project.resolve("vectors"))) {
            s.map(p -> "vectors/" + p.getFileName()).filter(n -> n.endsWith(".vec")).sorted().forEach(vec::add);
        } catch (IOException e) {
            // none
        }
        section("TEST VECTORS", vec);
        List<String> setup = new ArrayList<>(List.of("interface.cfg"));
        try (Stream<Path> s = Files.list(project.resolve("models"))) {
            s.map(p -> "models/" + p.getFileName()).filter(n -> n.endsWith(".model")).sorted().forEach(setup::add);
        } catch (IOException e) {
            // none
        }
        for (String f : List.of("board.cfg", "limits.cfg")) {
            if (Files.exists(project.resolve(f))) {
                setup.add(f);
            }
        }
        section("SETUP", setup);
        files.revalidate();
        files.repaint();
    }

    private void section(String title, List<String> names) {
        Theme t = Ui.t;
        JLabel h = Ui.label(title, 10.5f, Font.BOLD, t.faint);
        h.setBorder(BorderFactory.createEmptyBorder(t.px(12), t.px(10), t.px(4), 0));
        files.add(Ui.left(h));
        for (String n : names) {
            long errs = allDiags().stream().filter(d -> d.file().equals(n) && d.sev() == Diagnostics.Sev.ERROR).count();
            String label = (n.contains("/") ? n.substring(n.indexOf('/') + 1) : n) + (unsaved.containsKey(n) ? " *" : "");
            Widgets.NavItem it = new Widgets.NavItem(label, n.endsWith(".c") || n.endsWith(".h") ? "book" : "check", () -> open(n));
            it.selected(n.equals(current));
            if (errs > 0) {
                it.badge("FAIL");
            }
            it.setAlignmentX(Component.LEFT_ALIGNMENT);
            it.setToolTipText(n);
            files.add(it);
        }
    }

    private static boolean isFirmware(String n) {
        return n != null && n.matches("(fw|wd)_[a-z0-9_]{1,40}\\.[ch]");
    }

    /* ------------------------------------------------------------ files */

    void open(String rel) {
        current = rel;
        String text = unsaved.get(rel);
        if (text == null) {
            try {
                Path p = SafeFiles.inside(project, rel);
                text = Files.exists(p) ? Files.readString(p, StandardCharsets.UTF_8) : "";
            } catch (IOException | InputException e) {
                text = "";
            }
        }
        boolean keepUnsaved = unsaved.containsKey(rel);
        editor.load(text);
        if (keepUnsaved) {
            unsaved.put(rel, text);
        }
        // limits.cfg is signed by the hardware owner; changing it here would only break G14
        editor.setEditable(!rel.equals("limits.cfg"));
        if (rel.equals("limits.cfg")) {
            liveState.setText("read-only: signed by the hardware owner (kindgleam sign-limits)");
        }
        applyDiags();
        refreshFiles();
        updateTitle();
        if (isFirmware(rel) && live.isEmpty()) {
            runLive();
        }
    }

    void openAt(String rel, int line) {
        if (!rel.equals(current)) {
            open(rel);
        }
        SwingUtilities.invokeLater(() -> editor.goToLine(line));
    }

    /** Writes every edited file. Called before any run so Check and Verify see what is on screen. */
    void saveAll() {
        if (unsaved.isEmpty()) {
            return;
        }
        List<String> failed = new ArrayList<>();
        for (Map.Entry<String, String> e : new ArrayList<>(unsaved.entrySet())) {
            try {
                SafeFiles.writeAtomic(SafeFiles.inside(project, e.getKey()), e.getValue());
                unsaved.remove(e.getKey());
                staleAfterChange(e.getKey());
            } catch (IOException | InputException ex) {
                failed.add(e.getKey() + ": " + ex.getMessage());
            }
        }
        if (!failed.isEmpty()) {
            app.toast("Not saved: " + failed.get(0), "FAIL");
        }
        refreshFiles();
        updateTitle();
    }

    /** Markers from the last run describe the file as it was; once it changes they no longer apply. */
    private void staleAfterChange(String file) {
        List<Diagnostics.Diag> keep = new ArrayList<>(fromRun);
        keep.removeIf(d -> d.file().equals(file));
        fromRun = keep;
    }

    boolean dirty() {
        return !unsaved.isEmpty();
    }

    private void newFile() {
        String n = Dialogs.input(app.frame, "New firmware file", "File name with an fw_ or wd_ prefix, ending in .c or .h.", "fw_new.c", "Create file");
        if (n == null) {
            return;
        }
        n = n.strip();
        if (!isFirmware(n)) {
            app.toast("Use a name like fw_fan.c or fw_fan.h (lower case, digits and _).", "BLOCKED");
            return;
        }
        if (Files.exists(project.resolve(n))) {
            open(n);
            return;
        }
        String base = n.substring(0, n.length() - 2);
        String body = n.endsWith(".h")
                ? "#ifndef " + base.toUpperCase(java.util.Locale.ROOT) + "_H\n#define " + base.toUpperCase(java.util.Locale.ROOT)
                        + "_H\n\n#include <stdint.h>\n\n#endif\n"
                : "#include <stdint.h>\n\n";
        unsaved.put(n, body);
        current = null;
        open(n);
        app.toast("New file " + n + ". Write it yourself, or ask the assistant to write it.", "OK");
    }

    private void updateTitle() {
        Theme t = Ui.t;
        fileLabel.setText(current == null ? "" : current + (unsaved.containsKey(current) ? "  ●" : ""));
        long e = allDiags().stream().filter(d -> d.sev() == Diagnostics.Sev.ERROR).count();
        long w = allDiags().stream().filter(d -> d.sev() == Diagnostics.Sev.WARNING).count();
        long s = suggestions.size();
        counts.setFont(t.size(12f, Font.PLAIN));
        counts.setForeground(e > 0 ? t.fail : w > 0 ? t.warn : t.pass);
        counts.setText(e + " error" + (e == 1 ? "" : "s") + "  ·  " + w + " warning" + (w == 1 ? "" : "s")
                + (s > 0 ? "  ·  " + s + " suggestion" + (s == 1 ? "" : "s") : ""));
    }

    /* ------------------------------------------------------------ markers */

    private List<Diagnostics.Diag> allDiags() {
        List<Diagnostics.Diag> all = new ArrayList<>(live);
        // run results describe the saved file; once a file is edited its live check is the truth for errors
        for (Diagnostics.Diag d : fromRun) {
            if (!(unsaved.containsKey(d.file()) && d.sev() == Diagnostics.Sev.ERROR)) {
                all.add(d);
            }
        }
        all.addAll(suggestions);
        return all;
    }

    private void applyDiags() {
        List<Diagnostics.Diag> mine = new ArrayList<>();
        for (Diagnostics.Diag d : allDiags()) {
            if (d.file().equals(current)) {
                mine.add(d);
            }
        }
        editor.setDiags(mine);
        refreshProblems();
        updateTitle();
    }

    private void runLive() {
        Map<String, String> texts = new LinkedHashMap<>(unsaved);
        Thread w = new Thread(() -> {
            List<Diagnostics.Diag> d = Diagnostics.live(project, texts);
            SwingUtilities.invokeLater(() -> {
                live = d;
                long e = d.stream().filter(x -> x.sev() == Diagnostics.Sev.ERROR).count();
                liveState.setText(e == 0 ? "compiles cleanly" : "");
                applyDiags();
                refreshFiles();
            });
        }, "kg-live-check");
        w.setDaemon(true);
        w.start();
    }

    /** Called when a run finishes (and on open): reads its results into markers. */
    void runFinished(String run) {
        lastRun = run;
        int stack = 256;
        try {
            stack = kg.core.Profile.load(project.resolve("profile.cfg")).stackMaxFrame;
        } catch (InputException e) {
            // default
        }
        fromRun = Diagnostics.fromRun(project, run, stack);
        applyDiags();
        refreshFiles();
    }

    private String latestRun() {
        List<ProjectData.Run> r = app.data.runs().stream().filter(x -> !x.isEval()).toList();
        return r.isEmpty() ? null : r.get(0).id();
    }

    private void refreshProblems() {
        Theme t = Ui.t;
        problems.removeAll();
        problems.setBorder(BorderFactory.createEmptyBorder(t.px(6), t.px(8), t.px(6), t.px(8)));
        List<Diagnostics.Diag> all = new ArrayList<>(allDiags());
        all.sort((a, b) -> a.sev() != b.sev() ? a.sev().compareTo(b.sev())
                : a.file().equals(b.file()) ? Integer.compare(a.line(), b.line()) : a.file().compareTo(b.file()));
        JLabel h = Ui.label("PROBLEMS AND SUGGESTIONS" + (lastRun == null ? "" : "   (last run " + lastRun + ")"), 10.5f, Font.BOLD, t.faint);
        problems.add(Ui.left(h));
        if (all.isEmpty()) {
            problems.add(Ui.left(Ui.muted("No problems found.")));
        }
        for (Diagnostics.Diag d : all.subList(0, Math.min(200, all.size()))) {
            JPanel row = new JPanel(new BorderLayout(t.px(8), 0));
            row.setOpaque(false);
            row.setBorder(BorderFactory.createEmptyBorder(t.px(2), 0, t.px(2), 0));
            JLabel dot = new JLabel("●");
            dot.setForeground(CodeEditor.colourOf(d.sev()));
            JLabel txt = Ui.label(d.file() + ":" + d.line() + "   " + d.text() + "   — " + d.source(), 12f, Font.PLAIN, t.text);
            row.add(dot, BorderLayout.WEST);
            row.add(txt, BorderLayout.CENTER);
            row.setCursor(java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR));
            row.addMouseListener(new MouseAdapter() {
                @Override
                public void mouseClicked(MouseEvent e) {
                    if (!d.file().isEmpty()) {
                        openAt(d.file(), d.line());
                    }
                }
            });
            row.setAlignmentX(Component.LEFT_ALIGNMENT);
            row.setMaximumSize(new Dimension(Integer.MAX_VALUE, row.getPreferredSize().height));
            problems.add(row);
        }
        problems.revalidate();
        problems.repaint();
    }

    private void markerMenu(int line, List<Diagnostics.Diag> l) {
        JPopupMenu m = new JPopupMenu();
        boolean fixable = l.stream().anyMatch(d -> d.sev() != Diagnostics.Sev.INFO || d.source().startsWith("G6"));
        JMenuItem fix = new JMenuItem("Ask the assistant to fix line " + line);
        fix.setEnabled(fixable && isFirmware(current));
        fix.addActionListener(e -> {
            StringBuilder note = new StringBuilder("Problem at " + current + " line " + line + ":");
            for (Diagnostics.Diag d : l) {
                note.append(" [").append(d.source()).append("] ").append(d.text()).append('.');
            }
            note.append(" Fix this with the smallest change.");
            ask(l.stream().anyMatch(d -> d.source().startsWith("G7") || d.source().startsWith("G6"))
                    ? Assistant.Task.VECTOR : Assistant.Task.FIX, trim(note.toString()), null);
        });
        JMenuItem copy = new JMenuItem("Copy the message");
        copy.addActionListener(e -> java.awt.Toolkit.getDefaultToolkit().getSystemClipboard()
                .setContents(new java.awt.datatransfer.StringSelection(l.get(0).text()), null));
        m.add(fix);
        m.add(copy);
        java.awt.Point p = editor.getMousePosition();
        m.show(editor, 10, p == null ? 10 : p.y);
    }

    private static String trim(String s) {
        return s.length() > Guard.MAX_NOTE ? s.substring(0, Guard.MAX_NOTE - 3) + "..." : s;
    }

    /* ------------------------------------------------------------ assistant */

    private void buildAssistant() {
        Theme t = Ui.t;
        assistBody.removeAll();
        assistBody.setBorder(BorderFactory.createEmptyBorder(t.px(14), t.px(14), t.px(14), t.px(14)));
        ModelStore.Status st = new ModelStore(app.home).status();
        JPanel head = new JPanel(new BorderLayout());
        head.setOpaque(false);
        head.add(Ui.h2("Assistant"), BorderLayout.WEST);
        JPanel pill = new JPanel(new java.awt.GridBagLayout());
        pill.setOpaque(false);
        boolean on = app.settings.assistantEnabled && st.ready();
        pill.add(Ui.status(on ? "READY" : "OFF"));
        head.add(pill, BorderLayout.EAST);
        assistBody.add(Ui.left(head));
        assistBody.add(Ui.gap(4));
        assistBody.add(Ui.left(Ui.muted("Local and offline. It suggests; you decide.")));
        assistBody.add(Ui.gap(12));
        if (!app.settings.assistantEnabled || !st.ready()) {
            JTextArea why = Ui.textBlock(!app.settings.assistantEnabled
                    ? "The assistant is off. Turn it on in Settings.\n\nThe red, amber and grey markers on your code still work without it: "
                      + "they come from Kindgleam's own checks."
                    : st.message(), false);
            assistBody.add(Ui.left(why));
            assistBody.add(Ui.gap(10));
            Ui.Btn go = new Ui.Btn("Open Settings", Ui.Kind.SECONDARY, "gear");
            go.addActionListener(e -> app.show("Settings"));
            assistBody.add(Ui.left(go));
            return;
        }
        // quick actions
        JPanel q1 = new JPanel(new java.awt.GridLayout(0, 2, t.px(6), t.px(6)));
        q1.setOpaque(false);
        Ui.Btn fix = new Ui.Btn("Fix this file", Ui.Kind.SECONDARY);
        Ui.Btn explain = new Ui.Btn("Explain", Ui.Kind.SECONDARY);
        Ui.Btn review = new Ui.Btn("Review last run", Ui.Kind.SECONDARY);
        fix.addActionListener(e -> {
            StringBuilder note = new StringBuilder();
            for (Diagnostics.Diag d : allDiags()) {
                if (d.file().equals(current) && d.sev() == Diagnostics.Sev.ERROR && note.length() < 1200) {
                    note.append("line ").append(d.line()).append(": ").append(d.text()).append(". ");
                }
            }
            ask(Assistant.Task.FIX, note.length() == 0 ? "" : trim("Problems shown in the editor: " + note), null);
        });
        explain.addActionListener(e -> ask(Assistant.Task.EXPLAIN, "", null));
        review.addActionListener(e -> ask(Assistant.Task.REVIEW, "", null));
        Ui.Btn test = new Ui.Btn("Write a test", Ui.Kind.SECONDARY);
        test.setToolTipText("Write a test vector for the requirement chosen below");
        q1.add(fix);
        q1.add(explain);
        q1.add(review);
        q1.add(test);
        assistBody.add(Ui.left(q1));
        assistBody.add(Ui.gap(12));

        // write on request
        assistBody.add(Ui.left(Ui.label("Write or change code", 13f, Font.BOLD, t.text)));
        assistBody.add(Ui.gap(4));
        JTextArea req = new JTextArea(4, 20);
        req.setLineWrap(true);
        req.setWrapStyleWord(true);
        req.setFont(t.size(13f, Font.PLAIN));
        req.setForeground(t.text);
        req.setBackground(t.surface2);
        req.setCaretColor(t.accent);
        req.setBorder(BorderFactory.createEmptyBorder(t.px(8), t.px(10), t.px(8), t.px(10)));
        req.setText("");
        assistBody.add(Ui.left(req));
        assistBody.add(Ui.gap(6));
        List<String> ids = new ArrayList<>();
        ids.add("(no requirement)");
        for (Requirements.Req r : app.data.requirements()) {
            ids.add(r.id());
        }
        JComboBox<String> reqBox = new JComboBox<>(ids.toArray(new String[0]));
        reqBox.setBackground(t.surface2);
        reqBox.setForeground(t.text);
        reqBox.setFont(t.size(12.5f, Font.PLAIN));
        JPanel r2 = Ui.row(t.px(8));
        r2.add(Ui.muted("For"));
        r2.add(reqBox);
        Ui.Btn write = new Ui.Btn("Write it", Ui.Kind.PRIMARY, "spark");
        write.addActionListener(e -> {
            String text = req.getText().strip();
            String id = reqBox.getSelectedIndex() <= 0 ? null : (String) reqBox.getSelectedItem();
            if (text.isEmpty() && id == null) {
                app.toast("Describe what to write, or pick a requirement.", "BLOCKED");
                return;
            }
            ask(Assistant.Task.WRITE, text, id);
        });
        r2.add(write);
        test.addActionListener(e -> ask(Assistant.Task.VECTOR, req.getText().strip(),
                reqBox.getSelectedIndex() <= 0 ? guessRequirement() : (String) reqBox.getSelectedItem()));
        assistBody.add(Ui.left(r2));
        assistBody.add(Ui.gap(4));
        assistBody.add(Ui.left(Ui.muted("Works on the open file. For new code, click New file first.")));
        assistBody.add(Ui.gap(12));

        // live output
        JPanel sr = Ui.row(t.px(8));
        sr.add(assistStatus);
        if (busy) {
            Ui.Btn stop = new Ui.Btn("Stop", Ui.Kind.DANGER);
            stop.addActionListener(e -> {
                if (running != null) {
                    running.cancel();
                }
            });
            sr.add(stop);
        }
        assistBody.add(Ui.left(sr));
        stream.setBackground(t.surface2);
        stream.setBorder(BorderFactory.createEmptyBorder(t.px(8), t.px(10), t.px(8), t.px(10)));
        stream.setVisible(busy || !stream.getText().isBlank());
        assistBody.add(Ui.left(stream));
        assistBody.add(Ui.gap(10));
        assistBody.add(Ui.left(proposalBox));
        assistBody.add(Ui.gap(10));
        assistBody.add(Ui.left(suggestBox));
        showProposal();
        showSuggestions();
    }

    private EngineClient engine() {
        if (AssistPage.engine == null) {
            AssistPage.engine = new EngineClient(app.home, new ModelStore(app.home).status(), new ModelStore(app.home).logFile());
        }
        return AssistPage.engine;
    }

    /** Runs one assistant job in the background. */
    void ask(Assistant.Task task, String note, String requirement) {
        if (busy) {
            app.toast("The assistant is still working on the last request.", "BLOCKED");
            return;
        }
        if (!app.settings.assistantEnabled || !new ModelStore(app.home).status().ready()) {
            app.toast("Turn the assistant on in Settings first.", "BLOCKED");
            return;
        }
        String why = Guard.checkNote(note);
        if (why != null) {
            app.toast(why, "BLOCKED");
            return;
        }
        if (task != Assistant.Task.REVIEW && task != Assistant.Task.VECTOR && !isFirmware(current)) {
            app.toast("Open a firmware file (fw_*.c or .h) first.", "BLOCKED");
            return;
        }
        if (task == Assistant.Task.VECTOR && requirement == null) {
            requirement = guessRequirement();
            if (requirement == null) {
                app.toast("No requirement to test.", "BLOCKED");
                return;
            }
        }
        saveAll();
        busy = true;
        proposal = null;
        stream.setText("");
        assistStatus.setText("Starting the engine...");
        if (!assistOpen) {
            assistOpen = true;
        }
        build();
        Assistant.Request r = new Assistant.Request(task, current, requirement, note);
        Thread w = new Thread(() -> {
            String err = null;
            Assistant.Proposal p = null;
            try {
                running = new Assistant(app.home, project, engine());
                p = running.run(r, new Assistant.Listener() {
                    @Override
                    public void status(String s) {
                        SwingUtilities.invokeLater(() -> assistStatus.setText(s));
                    }

                    @Override
                    public void token(String s) {
                        SwingUtilities.invokeLater(() -> {
                            stream.append(s);
                            stream.setCaretPosition(stream.getDocument().getLength());
                        });
                    }
                });
            } catch (IOException | InputException | RuntimeException ex) {
                err = ex.getMessage();
            }
            Assistant.Proposal fp = p;
            String fe = err;
            SwingUtilities.invokeLater(() -> finished(r, fp, fe));
        }, "kg-assistant");
        w.setDaemon(true);
        w.start();
    }

    /**
     * Live suggestion after a pause in typing: only at the end of a line, with nothing selected and no
     * suggestion already showing, so it never interrupts. Stays quiet when it has nothing to offer.
     */
    private void suggest() {
        if (!app.settings.liveComplete || !app.settings.assistantEnabled || !isFirmware(current) || busy
                || editor.hasGhost() || editor.getSelectionStart() != editor.getSelectionEnd()) {
            return;
        }
        String text = editor.getText();
        int at = editor.getCaretPosition();
        int eol = text.indexOf('\n', at);
        if (!text.substring(at, eol < 0 ? text.length() : eol).isBlank() || !new ModelStore(app.home).status().ready()) {
            return;
        }
        complete(true);
    }

    /** Ctrl+Space (or a pause in typing): the model fills in code at the cursor, using what comes before and after it. */
    private void complete(boolean quiet) {
        if (!isFirmware(current) || busy) {
            return;
        }
        if (!app.settings.assistantEnabled || !new ModelStore(app.home).status().ready()) {
            app.toast("Code completion needs the assistant: turn it on in Settings.", "BLOCKED");
            return;
        }
        String text = editor.getText();
        int at = editor.getCaretPosition();
        String before = text.substring(Math.max(0, at - 6000), at);
        String after = text.substring(at, Math.min(text.length(), at + 2000));
        busy = true;
        liveState.setText(quiet ? "suggesting..." : "completing...");
        Thread w = new Thread(() -> {
            String got = null;
            String err = null;
            try {
                EngineClient.Result r = quiet ? engine().complete(before, after, 48, 20)
                        : engine().complete(before, after, 96, 90);
                got = r.text();
            } catch (IOException ex) {
                err = ex.getMessage();
            }
            String fg = got;
            String fe = err;
            SwingUtilities.invokeLater(() -> {
                busy = false;
                liveState.setText("");
                if (fe != null) {
                    if (!quiet) {
                        app.toast("Completion: " + fe, "FAIL");
                    }
                    return;
                }
                List<String> bad = Guard.checkReply(fg);
                if (!bad.isEmpty()) {
                    if (!quiet) {
                        app.toast("Completion withheld: " + bad.get(0), "BLOCKED");
                    }
                    return;
                }
                if (fg.isBlank()) {
                    if (!quiet) {
                        app.toast("No completion here.", "OK");
                    }
                    return;
                }
                // Typing while the model worked makes the suggestion stale: drop it.
                if (editor.getCaretPosition() == at && editor.getText().equals(text)) {
                    editor.showGhost(fg, at);
                }
            });
        }, "kg-complete");
        w.setDaemon(true);
        w.start();
    }

    private String guessRequirement() {
        List<Requirements.Req> rs = app.data.requirements();
        return rs.isEmpty() ? null : rs.get(0).id();
    }

    private void finished(Assistant.Request r, Assistant.Proposal p, String err) {
        busy = false;
        running = null;
        if (err != null) {
            assistStatus.setText("");
            app.toast("Assistant: " + err, "FAIL");
            build();
            return;
        }
        if (r.task() == Assistant.Task.REVIEW) {
            List<Diagnostics.Diag> s = Diagnostics.suggestions(p.explanation());
            suggestions = new ArrayList<>(s);
            assistStatus.setText(s.isEmpty() ? "Review done." : "Review done: " + s.size() + " suggestion" + (s.size() == 1 ? "" : "s")
                    + " placed on your code.");
            applyDiags();
            build();
            stream.setText(p.explanation());
            stream.setVisible(true);
            return;
        }
        if (r.task() == Assistant.Task.EXPLAIN) {
            assistStatus.setText("Done.");
            build();
            stream.setText(p.explanation());
            stream.setVisible(true);
            return;
        }
        proposal = p;
        assistStatus.setText(p.checkPassed() ? "Proposal ready: checks passed." : "Proposal ready, but checks did not pass.");
        build();
        stream.setText(p.attempts() > 1 ? "Took " + p.attempts() + " attempts; Kindgleam's checks sent the earlier ones back." : "");
        stream.setVisible(!stream.getText().isBlank());
    }

    private void showProposal() {
        Theme t = Ui.t;
        proposalBox.removeAll();
        Assistant.Proposal p = proposal;
        if (p == null || !p.checked()) {
            return;
        }
        JPanel head = new JPanel(new BorderLayout());
        head.setOpaque(false);
        head.add(Ui.label("Proposed change: " + p.relPath(), 13f, Font.BOLD, t.text), BorderLayout.WEST);
        JPanel pill = new JPanel(new java.awt.GridBagLayout());
        pill.setOpaque(false);
        pill.add(Ui.status(p.checkPassed() ? "PASS" : "FAIL"));
        head.add(pill, BorderLayout.EAST);
        proposalBox.add(Ui.left(head));
        proposalBox.add(Ui.gap(4));
        proposalBox.add(Ui.left(Ui.textBlock(p.checkSummary(), false)));
        if (!p.explanation().isBlank()) {
            proposalBox.add(Ui.left(Ui.textBlock(p.explanation(), false)));
        }
        if (p.hasChange()) {
            proposalBox.add(Ui.gap(8));
            JPanel act = Ui.row(t.px(8));
            Ui.Btn apply = new Ui.Btn(p.checkPassed() ? "Apply" : "Apply anyway", p.checkPassed() ? Ui.Kind.PRIMARY : Ui.Kind.DANGER);
            Ui.Btn reject = new Ui.Btn("Reject", Ui.Kind.SECONDARY);
            apply.addActionListener(e -> {
                try {
                    new Assistant(app.home, project, engine()).apply(p);
                    unsaved.remove(p.relPath());
                    staleAfterChange(p.relPath());
                    proposal = null;
                    suggestions.removeIf(d -> d.file().equals(p.relPath()));
                    refreshFiles();
                    current = null;
                    open(p.relPath());
                    editor.markChanged(changedLines(p.before(), p.after()));
                    assistStatus.setText("Applied to " + p.relPath() + ". Run Check or Verify to confirm.");
                    runLive();
                    build();
                } catch (IOException | InputException ex) {
                    app.toast(ex.getMessage(), "FAIL");
                }
            });
            reject.addActionListener(e -> {
                try {
                    new Assistant(app.home, project, engine()).reject(p);
                } catch (IOException | InputException ex) {
                    // recording the rejection is best effort
                }
                proposal = null;
                assistStatus.setText("Rejected.");
                build();
            });
            act.add(apply);
            act.add(reject);
            proposalBox.add(Ui.left(act));
            proposalBox.add(Ui.gap(8));
            proposalBox.add(Ui.left(AssistPage.diffView(p.before(), p.after())));
        }
    }

    private void showSuggestions() {
        Theme t = Ui.t;
        suggestBox.removeAll();
        if (suggestions.isEmpty()) {
            return;
        }
        suggestBox.add(Ui.left(Ui.label("Suggestions on your code", 13f, Font.BOLD, t.text)));
        suggestBox.add(Ui.gap(4));
        for (Diagnostics.Diag d : suggestions) {
            suggestBox.add(Pages.listRow(d.file() + ":" + d.line(), d.text(), null, () -> openAt(d.file(), d.line())));
        }
    }

    /** Lines of b that are new or changed compared with a (for the green bars after Apply). */
    static Set<Integer> changedLines(String a, String b) {
        Set<Integer> out = new HashSet<>();
        String[] x = a == null ? new String[0] : a.split("\n", -1);
        String[] y = b.split("\n", -1);
        if ((long) x.length * y.length > 4_000_000L) {
            return out;
        }
        int[][] l = new int[x.length + 1][y.length + 1];
        for (int i = x.length - 1; i >= 0; i--) {
            for (int j = y.length - 1; j >= 0; j--) {
                l[i][j] = x[i].equals(y[j]) ? l[i + 1][j + 1] + 1 : Math.max(l[i + 1][j], l[i][j + 1]);
            }
        }
        int i = 0;
        int j = 0;
        while (j < y.length) {
            if (i < x.length && x[i].equals(y[j])) {
                i++;
                j++;
            } else if (i < x.length && l[i + 1][j] >= l[i][j + 1]) {
                i++;
            } else {
                out.add(j + 1);
                j++;
            }
        }
        return out;
    }

    /** After a run: refresh markers and, if allowed, let the assistant review it in the background. */
    void afterRun(String run, boolean passed) {
        runFinished(run);
        if (app.settings.assistantEnabled && app.settings.autoReview && new ModelStore(app.home).status().ready() && !busy) {
            ask(Assistant.Task.REVIEW, "", null);
            app.toast("The assistant is reading the results of " + run + " in the background.", "RUNNING");
        }
    }

    static JComponent placeholder(String text) {
        return Pages.message("Code", text);
    }
}
