package kg.app;

import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Component;
import java.awt.Dimension;
import java.awt.Font;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.KeyboardFocusManager;
import java.awt.Toolkit;
import java.awt.event.KeyEvent;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import javax.swing.BorderFactory;
import javax.swing.JComponent;
import javax.swing.JFileChooser;
import javax.swing.JFrame;
import javax.swing.JLabel;
import javax.swing.JLayeredPane;
import javax.swing.JList;
import javax.swing.JPanel;
import javax.swing.JTextField;
import javax.swing.ListSelectionModel;
import javax.swing.SwingUtilities;
import javax.swing.Timer;
import javax.swing.UIManager;
import javax.swing.event.DocumentEvent;
import javax.swing.event.DocumentListener;

/**
 * Desktop shell: sidebar navigation, header actions (Check, Verify with a tier, Eval), live run
 * streaming, a Ctrl+K command palette and toasts. Every result shown comes from the CLI's own
 * output and evidence files; the app has no authority over any verdict.
 */
public final class App {
    final Path home;
    final AppSettings settings;
    ProjectData data;
    final Runner runner;
    final JFrame frame = new JFrame("Kindgleam");
    private final JPanel root = new JPanel(new BorderLayout());
    private final JPanel content = new JPanel(new BorderLayout());
    private final JPanel sidebar = Ui.column();
    private final Map<String, Widgets.NavItem> nav = new LinkedHashMap<>();
    private final Map<String, Supplier<JComponent>> pages = new LinkedHashMap<>();
    private final JLabel projectLabel = new JLabel();
    private Widgets.Segmented tier;
    private Ui.Btn checkBtn;
    private Ui.Btn verifyBtn;
    private Ui.Btn evalBtn;
    private Ui.Btn stopBtn;
    String current = "Overview";
    private CodePage code;
    private JPanel rail;
    private JLabel railTitle;

    /** The page rail shrinks to icons on the Code page so the editor gets the room. */
    private void railMode(boolean compact) {
        if (rail == null) {
            return;
        }
        nav.values().forEach(n -> n.compact(compact));
        rail.setPreferredSize(new Dimension(Ui.t.px(compact ? 64 : 190), 10));
        railTitle.setVisible(!compact);
        rail.revalidate();
    }

    /** One Code page per open project, kept while the project is open so edits and suggestions survive page switches. */
    private JComponent codePage() {
        if (code == null) {
            code = new CodePage(this);
        }
        return code;
    }
    private static String startPage = "Overview";
    final Pages.Live live = new Pages.Live();
    String focusRun;
    String focusVector;

    private App(Path home, Path project) {
        this.home = home;
        this.settings = AppSettings.load();
        this.runner = new Runner(home);
        Ui.t = Theme.of(settings.dark, settings.scale);
        Ui.reduceMotion = settings.reduceMotion;
        if (project != null) {
            openProject(project, false);
        }
    }

    public static void main(String[] args) {
        Path home = Path.of(System.getProperty("kg.home", ".")).toAbsolutePath().normalize();
        Path project = null;
        for (String a : args) {
            if (a.startsWith("--page=")) {
                startPage = a.substring(7);
            } else if (a.startsWith("--project=")) {
                project = Path.of(a.substring(10)).toAbsolutePath().normalize();
            } else if (!a.startsWith("-")) {
                project = Path.of(a).toAbsolutePath().normalize();
            }
        }
        System.setProperty("awt.useSystemAAFontSettings", "on");
        Path p = project;
        SwingUtilities.invokeLater(() -> {
            try {
                UIManager.setLookAndFeel(UIManager.getCrossPlatformLookAndFeelClassName());
            } catch (ReflectiveOperationException | javax.swing.UnsupportedLookAndFeelException e) {
                // default look and feel is fine
            }
            String wrong = kg.core.Platform.check(home);
            if (wrong != null) {
                Dialogs.message(null, Dialogs.Kind.DANGER, "This package is for a different system", wrong);
                System.exit(5);
            }
            App app = new App(home, p);
            Workspace.Found ws = Workspace.open(app.settings);
            if (app.data == null && !app.settings.recent.isEmpty()) {
                Path r = Path.of(app.settings.recent.get(0));
                if (Files.isDirectory(r)) {
                    app.openProject(r, false);
                }
            }
            app.current = startPage;
            app.build();
            if (!ws.existed()) {
                app.toast("Created your Kindgleam folder: " + Workspace.root() + ". Projects, keys and settings live there.", "OK");
            } else if (!ws.newlyListed().isEmpty()) {
                app.toast("Found " + ws.newlyListed().size() + " existing project" + (ws.newlyListed().size() == 1 ? "" : "s")
                        + " in " + Workspace.projects() + " and listed " + (ws.newlyListed().size() == 1 ? "it" : "them") + ".", "OK");
            }
            app.firstRun();
        });
    }

    /* ------------------------------------------------------------ project */

    void openProject(Path p, boolean rebuild) {
        if (!Files.isRegularFile(p.resolve("interface.cfg")) && !Files.isRegularFile(p.resolve("profile.cfg"))) {
            toast("Not a Kindgleam project (no interface.cfg or profile.cfg): " + p, "FAIL");
            return;
        }
        if (code != null) {
            code.saveAll();
            code = null;
        }
        data = new ProjectData(home, p);
        settings.remember(p);
        settings.save();
        focusRun = null;
        focusVector = null;
        if (rebuild) {
            layoutAll();
        }
    }

    void chooseProject() {
        JFileChooser fc = new JFileChooser(data != null ? data.project.toFile() : home.resolve("examples").toFile());
        fc.setFileSelectionMode(JFileChooser.DIRECTORIES_ONLY);
        fc.setDialogTitle("Open a Kindgleam project folder");
        if (fc.showOpenDialog(frame) == JFileChooser.APPROVE_OPTION) {
            openProject(fc.getSelectedFile().toPath().toAbsolutePath().normalize(), true);
        }
    }

    /* ------------------------------------------------------------ layout */

    private void build() {
        frame.setDefaultCloseOperation(JFrame.DISPOSE_ON_CLOSE);
        frame.addWindowListener(new java.awt.event.WindowAdapter() {
            @Override
            public void windowClosed(java.awt.event.WindowEvent e) {
                runner.cancel();
                AssistPage.shutdown();
                System.exit(0);
            }
        });
        pages.put("Overview", () -> Pages.overview(this));
        pages.put("Code", this::codePage);
        pages.put("Runs", () -> Pages.runs(this));
        pages.put("Oscilloscope", () -> Pages.scope(this));
        pages.put("Requirements", () -> Pages.requirements(this));
        pages.put("Evidence", () -> Pages.evidence(this));
        pages.put("Settings", () -> Pages.settings(this));
        frame.setContentPane(root);
        frame.setMinimumSize(new Dimension(Ui.t.px(980), Ui.t.px(640)));
        frame.setSize(Ui.t.px(1440), Ui.t.px(900));
        frame.setLocationRelativeTo(null);
        frame.setExtendedState(JFrame.MAXIMIZED_BOTH);
        layoutAll();
        installKeys();
        frame.setVisible(true);
    }

    /** Rebuilds every component; used on start and when theme or scale changes. */
    void layoutAll() {
        Theme t = Ui.t;
        root.removeAll();
        sidebar.removeAll();
        nav.clear();
        root.setBackground(t.bg);
        content.setOpaque(true);
        content.setBackground(t.bg);
        root.add(projectsBar(), BorderLayout.WEST);

        // right: the pages of the open project
        rail = new JPanel(new BorderLayout());
        rail.setBackground(t.sidebar);
        rail.setPreferredSize(new Dimension(t.px(190), 10));
        rail.setBorder(BorderFactory.createMatteBorder(0, 1, 0, 0, t.border));
        JLabel ph = Ui.label(data == null ? "NO PROJECT" : data.name().toUpperCase(java.util.Locale.ROOT), 10.5f, Font.BOLD, t.faint);
        ph.setBorder(BorderFactory.createEmptyBorder(t.px(22), t.px(22), t.px(8), t.px(8)));
        railTitle = ph;
        rail.add(ph, BorderLayout.NORTH);
        String[][] items = {{"Overview", "home"}, {"Code", "book"}, {"Runs", "runs"}, {"Oscilloscope", "wave"},
            {"Requirements", "check"}, {"Evidence", "shield"}};
        for (String[] it : items) {
            addNav(it[0], it[1]);
        }
        rail.add(sidebar, BorderLayout.CENTER);
        JPanel foot = Ui.column();
        foot.setBorder(BorderFactory.createEmptyBorder(0, 0, t.px(12), 0));
        Widgets.NavItem settingsItem = new Widgets.NavItem("Settings", "gear", () -> show("Settings"));
        nav.put("Settings", settingsItem);
        foot.add(settingsItem);
        rail.add(foot, BorderLayout.SOUTH);
        root.add(rail, BorderLayout.EAST);

        JPanel main = new JPanel(new BorderLayout());
        main.setOpaque(false);
        main.add(header(), BorderLayout.NORTH);
        main.add(content, BorderLayout.CENTER);
        root.add(main, BorderLayout.CENTER);
        refreshBadges();
        show(current);
        root.revalidate();
        root.repaint();
    }

    /** Left: every project workspace, with New project and Open folder. */
    private JComponent projectsBar() {
        Theme t = Ui.t;
        JPanel side = new JPanel(new BorderLayout());
        side.setBackground(t.sidebar);
        side.setPreferredSize(new Dimension(t.px(240), 10));
        side.setBorder(BorderFactory.createMatteBorder(0, 0, 0, 1, t.border));
        JPanel brand = new JPanel(new BorderLayout()) {
            private static final long serialVersionUID = 1L;

            @Override
            protected void paintComponent(Graphics g0) {
                Graphics2D g = (Graphics2D) g0.create();
                Ui.hints(g);
                int s = t.px(26);
                g.setColor(t.accent);
                g.fillRoundRect(t.px(18), t.px(18), s, s, t.px(8), t.px(8));
                Ui.icon(g, "spark", t.px(22), t.px(22), t.px(18), Color.WHITE);
                g.setColor(t.text);
                g.setFont(t.size(16f, Font.BOLD));
                g.drawString("Kindgleam", t.px(54), t.px(37));
                g.dispose();
            }
        };
        brand.setOpaque(false);
        brand.setPreferredSize(new Dimension(10, t.px(62)));
        JPanel top = Ui.column();
        top.add(Ui.left(brand));
        JPanel btns = Ui.column();
        btns.setBorder(BorderFactory.createEmptyBorder(t.px(4), t.px(14), t.px(10), t.px(14)));
        Ui.Btn np = new Ui.Btn("New project", Ui.Kind.PRIMARY, "spark");
        np.addActionListener(e -> newProject());
        Ui.Btn op = new Ui.Btn("Open folder", Ui.Kind.SECONDARY);
        op.addActionListener(e -> chooseProject());
        btns.add(Ui.left(np));
        btns.add(Ui.gap(6));
        btns.add(Ui.left(op));
        top.add(Ui.left(btns));
        JLabel h = Ui.label("PROJECTS", 10.5f, Font.BOLD, t.faint);
        h.setBorder(BorderFactory.createEmptyBorder(t.px(10), t.px(22), t.px(6), 0));
        top.add(Ui.left(h));
        side.add(top, BorderLayout.NORTH);

        JPanel list = Ui.column();
        for (String r : new ArrayList<>(settings.recent)) {
            Path p = Path.of(r);
            if (!Files.isDirectory(p)) {
                continue;
            }
            Widgets.NavItem it = new Widgets.NavItem(p.getFileName().toString(), "book", () -> {
                if (data == null || !data.project.equals(p)) {
                    openProject(p, true);
                }
            });
            it.setToolTipText(r);
            it.selected(data != null && data.project.equals(p));
            List<ProjectData.Run> runs = new ProjectData(home, p).runs();
            if (!runs.isEmpty()) {
                it.badge(runs.get(0).label());
            }
            it.setAlignmentX(Component.LEFT_ALIGNMENT);
            it.addMouseListener(new java.awt.event.MouseAdapter() {
                @Override
                public void mousePressed(java.awt.event.MouseEvent e) {
                    if (e.isPopupTrigger()) {
                        menu(e);
                    }
                }

                @Override
                public void mouseReleased(java.awt.event.MouseEvent e) {
                    if (e.isPopupTrigger()) {
                        menu(e);
                    }
                }

                private void menu(java.awt.event.MouseEvent e) {
                    javax.swing.JPopupMenu m = new javax.swing.JPopupMenu();
                    javax.swing.JMenuItem rm = new javax.swing.JMenuItem("Remove from this list (files are kept)");
                    rm.addActionListener(a -> {
                        settings.recent.remove(r);
                        settings.save();
                        layoutAll();
                    });
                    m.add(rm);
                    m.show(it, e.getX(), e.getY());
                }
            });
            list.add(it);
        }
        if (settings.recent.isEmpty()) {
            JLabel none = Ui.muted("No projects yet");
            none.setBorder(BorderFactory.createEmptyBorder(0, t.px(22), 0, 0));
            list.add(Ui.left(none));
        }
        JPanel wrap = new JPanel(new BorderLayout());
        wrap.setOpaque(false);
        wrap.add(list, BorderLayout.NORTH);
        side.add(Ui.scroll(wrap), BorderLayout.CENTER);
        return side;
    }

    void newProject() {
        Theme t = Ui.t;
        JPanel f = Ui.column();
        javax.swing.JTextField name = Dialogs.field("my-controller");
        javax.swing.JComboBox<String> tpl = Dialogs.combo(NewProject.TEMPLATES);
        f.add(Dialogs.label("Project name"));
        f.add(name);
        f.add(Dialogs.label("Start from"));
        f.add(tpl);
        if (!Dialogs.form(frame, Dialogs.Kind.INFO, "New project", "Saved in " + NewProject.defaultRoot(), f, "Create project", "Cancel")) {
            return;
        }
        try {
            Path parent = NewProject.defaultRoot();
            Files.createDirectories(parent);
            Path dir = NewProject.create(home, parent, name.getText().strip(), tpl.getSelectedIndex());
            openProject(dir, false);
            current = "Code";
            layoutAll();
            toast("Project " + dir.getFileName() + " created in its own workspace. Press Check to build it.", "OK");
        } catch (java.io.IOException | kg.core.InputException | java.security.GeneralSecurityException | RuntimeException ex) {
            toast("Not created: " + ex.getMessage(), "FAIL");
        }
    }

    private void addNav(String name, String icon) {
        Widgets.NavItem n = new Widgets.NavItem(name, icon, () -> show(name));
        n.setAlignmentX(Component.LEFT_ALIGNMENT);
        nav.put(name, n);
        sidebar.add(n);
    }

    private JComponent header() {
        Theme t = Ui.t;
        JPanel h = new JPanel(new BorderLayout());
        h.setBackground(t.bg);
        h.setBorder(BorderFactory.createCompoundBorder(BorderFactory.createMatteBorder(0, 0, 1, 0, t.border),
                BorderFactory.createEmptyBorder(t.px(12), t.px(24), t.px(12), t.px(20))));
        Ui.Btn search = new Ui.Btn("Search or run a command   Ctrl+K", Ui.Kind.SECONDARY, "search");
        search.setFont(t.size(12.5f, Font.PLAIN));
        search.addActionListener(e -> palette());
        h.add(search, BorderLayout.WEST);
        JPanel r = Ui.row(t.px(8));
        tier = new Widgets.Segmented(new String[] {"SIL", "PIL", "HIL"}, settings.defaultTier);
        checkBtn = new Ui.Btn("Check", Ui.Kind.SECONDARY, "bolt");
        verifyBtn = new Ui.Btn("Verify", Ui.Kind.PRIMARY, "play");
        evalBtn = new Ui.Btn("Eval", Ui.Kind.GHOST);
        stopBtn = new Ui.Btn("Stop", Ui.Kind.DANGER);
        checkBtn.addActionListener(e -> runCheck());
        verifyBtn.addActionListener(e -> runVerify(tier.value().toLowerCase(java.util.Locale.ROOT)));
        evalBtn.addActionListener(e -> runEval());
        stopBtn.addActionListener(e -> {
            runner.cancel();
            toast("Run stopped. Nothing from a stopped run is recorded as a verdict.", "BLOCKED");
        });
        Ui.Btn theme = new Ui.Btn("", Ui.Kind.GHOST, settings.dark ? "sun" : "moon");
        theme.setToolTipText("Switch light / dark");
        theme.addActionListener(e -> setTheme(!settings.dark));
        r.add(tier);
        r.add(checkBtn);
        r.add(verifyBtn);
        r.add(evalBtn);
        r.add(stopBtn);
        r.add(theme);
        h.add(r, BorderLayout.EAST);
        updateRunButtons();
        return h;
    }

    void updateRunButtons() {
        boolean busy = runner.busy();
        boolean has = data != null;
        if (checkBtn != null) {
            checkBtn.setEnabled(!busy && has);
            verifyBtn.setEnabled(!busy && has);
            evalBtn.setEnabled(!busy && has);
            stopBtn.setVisible(busy);
        }
    }

    void setTheme(boolean dark) {
        if (code != null) {
            code.saveAll();
            code = null;
        }
        settings.dark = dark;
        settings.save();
        Ui.t = Theme.of(dark, settings.scale);
        layoutAll();
    }

    void setScale(float s) {
        if (code != null) {
            code.saveAll();
            code = null;
        }
        settings.scale = s;
        settings.save();
        Ui.t = Theme.of(settings.dark, s);
        layoutAll();
    }

    void show(String name) {
        current = name;
        nav.forEach((k, v) -> v.selected(k.equals(name)));
        railMode(name.equals("Code"));
        content.removeAll();
        JComponent page;
        if (data == null && !name.equals("Settings") && !name.equals("Skills")) {
            page = Pages.welcome(this);
        } else {
            try {
                page = pages.get(name).get();
            } catch (RuntimeException ex) {
                page = Pages.message("Could not show " + name, String.valueOf(ex.getMessage()));
            }
        }
        content.add(new Ui.Fade(page), BorderLayout.CENTER);
        content.revalidate();
        content.repaint();
    }

    void refreshBadges() {
        Widgets.NavItem runs = nav.get("Runs");
        if (runs == null) {
            return;
        }
        if (runner.busy()) {
            runs.badge("RUNNING");
        } else if (data != null) {
            List<ProjectData.Run> rs = data.runs();
            runs.badge(rs.isEmpty() ? null : rs.get(0).label());
        } else {
            runs.badge(null);
        }
    }

    /* ------------------------------------------------------------ runs */

    void runCheck() {
        start(List.of("check"), "Check");
    }

    void runVerify(String t) {
        if (t.equals("hil") && settings.confirmHil) {
            boolean ok = Dialogs.confirm(frame, Dialogs.Kind.WARNING, "Run on real hardware?",
                    "HIL drives a real board. Before continuing confirm:\n\n"
                    + "  - the board in board.cfg is the one connected over USB\n"
                    + "  - limits.cfg is signed and matches this rig\n"
                    + "  - an operator can cut power to the rig\n\n"
                    + "Kindgleam still checks identity and signed limits itself and stops if anything does not match.",
                    "Run on hardware", "Cancel");
            if (!ok) {
                return;
            }
        }
        start(List.of("verify", "--tier=" + t), "Verify " + t.toUpperCase(java.util.Locale.ROOT));
    }

    void runEval() {
        start(List.of("eval"), "Eval");
    }

    private void start(List<String> args, String title) {
        if (data == null) {
            toast("Open a project first.", "BLOCKED");
            return;
        }
        if (code != null) {
            code.saveAll();
        }
        live.reset(title);
        try {
            runner.start(data.project, args, ev -> {
                live.accept(ev);
                if (ev.kind().equals("run") && ev.f().length > 1) {
                    focusRun = ev.f()[1];
                }
            }, exit -> {
                live.finish(exit);
                updateRunButtons();
                refreshBadges();
                String word = live.verdict != null ? live.verdict : (exit == 0 ? "OK" : "FAIL");
                toast(title + " finished: " + word + (live.reason.isEmpty() ? "" : " - " + live.reason), word);
                if (code != null && !live.runId.isEmpty()) {
                    code.afterRun(live.runId, exit == 0);
                }
                layoutAll();
            });
        } catch (java.io.IOException e) {
            toast("Could not start: " + e.getMessage(), "FAIL");
            return;
        }
        updateRunButtons();
        refreshBadges();
        if (!current.equals("Code")) {
            show("Runs");
        }
    }

    /* ------------------------------------------------------------ toasts */

    void toast(String text, String status) {
        if (!frame.isShowing()) {
            return;
        }
        Theme t = Ui.t;
        JLayeredPane lp = frame.getLayeredPane();
        Ui.Card c = new Ui.Card(t.px(12));
        c.fill = t.surface;
        JLabel l = new JLabel("<html><body style='width:" + t.px(320) + "px'>" + esc(text) + "</body></html>");
        l.setFont(t.size(13f, Font.PLAIN));
        l.setForeground(t.text);
        JPanel in = new JPanel(new BorderLayout(t.px(10), 0));
        in.setOpaque(false);
        in.add(Ui.status(status), BorderLayout.WEST);
        in.add(l, BorderLayout.CENTER);
        c.add(in);
        Dimension d = c.getPreferredSize();
        int x = lp.getWidth() - d.width - t.px(24);
        int y0 = lp.getHeight();
        int y1 = lp.getHeight() - d.height - t.px(24);
        c.setBounds(x, y0, d.width, d.height);
        lp.add(c, JLayeredPane.POPUP_LAYER);
        long start = System.currentTimeMillis();
        Timer tm = new Timer(16, null);
        tm.addActionListener(e -> {
            long ms = System.currentTimeMillis() - start;
            float in1 = Ui.reduceMotion ? 1f : Math.min(1f, ms / 220f);
            float out = ms > 4200 ? Math.min(1f, (ms - 4200) / 220f) : 0f;
            float k = 1f - (float) Math.pow(1 - in1, 3);
            int y = Math.round(y0 + (y1 - y0) * k + out * (y0 - y1));
            c.setLocation(x, y);
            if (ms > 4450) {
                tm.stop();
                lp.remove(c);
                lp.repaint();
            }
        });
        tm.start();
    }

    static String esc(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    /* ------------------------------------------------------------ command palette */

    private void installKeys() {
        KeyboardFocusManager.getCurrentKeyboardFocusManager().addKeyEventDispatcher(e -> {
            int mod = Toolkit.getDefaultToolkit().getMenuShortcutKeyMaskEx();
            if (e.getID() == KeyEvent.KEY_PRESSED && e.getKeyCode() == KeyEvent.VK_K && (e.getModifiersEx() & mod) != 0) {
                palette();
                return true;
            }
            return false;
        });
    }

    private record Cmd(String label, String hint, Runnable action) {
        @Override
        public String toString() {
            return label;
        }
    }

    void palette() {
        Theme t = Ui.t;
        List<Cmd> all = new ArrayList<>();
        all.add(new Cmd("Run Check", "fast gates G0-G4", this::runCheck));
        all.add(new Cmd("Verify SIL", "full gates in simulation", () -> runVerify("sil")));
        all.add(new Cmd("Verify PIL", "on the virtual or USB board", () -> runVerify("pil")));
        all.add(new Cmd("Verify HIL", "real hardware, asks first", () -> runVerify("hil")));
        all.add(new Cmd("Run Eval", "flaky and golden drift", this::runEval));
        for (String p : pages.keySet()) {
            all.add(new Cmd("Go to " + p, "page", () -> show(p)));
        }
        all.add(new Cmd("Open project...", "choose a folder", this::chooseProject));
        all.add(new Cmd("Toggle theme", settings.dark ? "light" : "dark", () -> setTheme(!settings.dark)));
        if (data != null) {
            for (String v : data.vectorNames()) {
                all.add(new Cmd("Scope: " + v, "open vector in the oscilloscope", () -> {
                    focusVector = v;
                    show("Oscilloscope");
                }));
            }
        }
        javax.swing.JDialog d = new javax.swing.JDialog(frame, false);
        d.setUndecorated(true);
        Ui.Card card = new Ui.Card(t.px(14));
        card.setLayout(new BorderLayout(0, t.px(8)));
        JTextField q = new JTextField();
        q.setFont(t.size(15f, Font.PLAIN));
        q.setForeground(t.text);
        q.setCaretColor(t.accent);
        q.setBackground(t.surface2);
        q.setBorder(BorderFactory.createEmptyBorder(t.px(10), t.px(12), t.px(10), t.px(12)));
        javax.swing.DefaultListModel<Cmd> model = new javax.swing.DefaultListModel<>();
        JList<Cmd> list = new JList<>(model);
        list.setSelectionMode(ListSelectionModel.SINGLE_SELECTION);
        list.setOpaque(false);
        list.setBackground(t.surface);
        list.setCellRenderer((lst, v, i, sel, foc) -> {
            JPanel p = new JPanel(new BorderLayout());
            p.setBackground(sel ? t.hover : t.surface);
            p.setBorder(BorderFactory.createEmptyBorder(t.px(8), t.px(12), t.px(8), t.px(12)));
            JLabel a = Ui.label(v.label(), 13.5f, Font.PLAIN, t.text);
            JLabel b = Ui.label(v.hint(), 12f, Font.PLAIN, t.muted);
            p.add(a, BorderLayout.WEST);
            p.add(b, BorderLayout.EAST);
            return p;
        });
        Runnable filter = () -> {
            String s = q.getText().toLowerCase(java.util.Locale.ROOT).strip();
            model.clear();
            for (Cmd c : all) {
                if (fuzzy(c.label().toLowerCase(java.util.Locale.ROOT), s)) {
                    model.addElement(c);
                }
            }
            if (!model.isEmpty()) {
                list.setSelectedIndex(0);
            }
        };
        filter.run();
        q.getDocument().addDocumentListener(new DocumentListener() {
            @Override
            public void insertUpdate(DocumentEvent e) {
                filter.run();
            }

            @Override
            public void removeUpdate(DocumentEvent e) {
                filter.run();
            }

            @Override
            public void changedUpdate(DocumentEvent e) {
                filter.run();
            }
        });
        Runnable go = () -> {
            Cmd c = list.getSelectedValue();
            d.dispose();
            if (c != null) {
                c.action().run();
            }
        };
        q.addActionListener(e -> go.run());
        q.addKeyListener(new java.awt.event.KeyAdapter() {
            @Override
            public void keyPressed(KeyEvent e) {
                int i = list.getSelectedIndex();
                if (e.getKeyCode() == KeyEvent.VK_DOWN && i < model.size() - 1) {
                    list.setSelectedIndex(i + 1);
                    list.ensureIndexIsVisible(i + 1);
                } else if (e.getKeyCode() == KeyEvent.VK_UP && i > 0) {
                    list.setSelectedIndex(i - 1);
                    list.ensureIndexIsVisible(i - 1);
                } else if (e.getKeyCode() == KeyEvent.VK_ESCAPE) {
                    d.dispose();
                }
            }
        });
        list.addMouseListener(new java.awt.event.MouseAdapter() {
            @Override
            public void mouseClicked(java.awt.event.MouseEvent e) {
                go.run();
            }
        });
        d.addWindowFocusListener(new java.awt.event.WindowAdapter() {
            @Override
            public void windowLostFocus(java.awt.event.WindowEvent e) {
                d.dispose();
            }
        });
        card.add(q, BorderLayout.NORTH);
        card.add(Ui.scroll(list), BorderLayout.CENTER);
        d.setContentPane(card);
        d.setBackground(new Color(0, 0, 0, 0));
        d.setSize(t.px(560), t.px(420));
        d.setLocation(frame.getX() + (frame.getWidth() - d.getWidth()) / 2, frame.getY() + t.px(90));
        d.setVisible(true);
        q.requestFocusInWindow();
    }

    /** True when every character of q appears in s in order. */
    static boolean fuzzy(String s, String q) {
        int j = 0;
        for (int i = 0; i < s.length() && j < q.length(); i++) {
            if (s.charAt(i) == q.charAt(j)) {
                j++;
            }
        }
        return j == q.length();
    }

    /* ------------------------------------------------------------ first run on a computer */

    private static boolean hasKey() {
        try {
            kg.verdict.Keys.loadPublic(kg.verdict.Keys.defaultDir());
            kg.verdict.Keys.loadPrivate(kg.verdict.Keys.defaultDir());
            return true;
        } catch (java.io.IOException | java.security.GeneralSecurityException e) {
            return false;
        }
    }

    /**
     * A new computer needs a signing key and a seal of the installed tools before the first run.
     * The app does both itself (with the person's agreement) so nobody needs the command line.
     */
    void firstRun() {
        boolean key = hasKey();
        boolean sealed = Files.exists(kg.core.Places.writable(home).resolve("baseline.txt"));
        if (key && sealed) {
            return;
        }
        if (!key) {
            boolean ok = Dialogs.confirm(frame, Dialogs.Kind.INFO, "Set up this computer",
                    "Welcome to Kindgleam.\n\nThis computer needs a signing key before the first run. Kindgleam signs every verdict,\n"
                    + "the board limits and the installed tools with it, so any later change is detected.\n\n"
                    + "The key is created in " + kg.verdict.Keys.defaultDir() + " and never leaves this computer.\n\nCreate it now?",
                    "Create key", "Later");
            if (!ok) {
                toast("Kindgleam needs a signing key before it can run checks. You can set it up later in Settings.", "BLOCKED");
                return;
            }
        }
        setupComputer(!key);
    }

    /** Creates the key if asked, then seals the installed tools (after install or an update). */
    void setupComputer(boolean withKey) {
        List<String> steps = new ArrayList<>();
        if (withKey) {
            steps.add("keygen");
        }
        steps.add("baseline");
        runSteps(steps, 0);
    }

    private void runSteps(List<String> steps, int i) {
        if (i >= steps.size()) {
            toast("This computer is set up: signing key ready and installed tools sealed.", "PASS");
            layoutAll();
            return;
        }
        try {
            StringBuilder out = new StringBuilder();
            new Runner(home).start(home, List.of(steps.get(i)), ev -> out.append(ev.raw()).append('\n'), code -> {
                if (code != 0) {
                    toast("Setup step '" + steps.get(i) + "' failed: " + out.toString().strip(), "FAIL");
                    return;
                }
                runSteps(steps, i + 1);
            });
        } catch (java.io.IOException e) {
            toast("Setup failed: " + e.getMessage(), "FAIL");
        }
    }
}
