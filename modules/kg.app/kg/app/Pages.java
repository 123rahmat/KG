package kg.app;

import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Component;
import java.awt.Dimension;
import java.awt.Font;
import java.awt.FontMetrics;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.GridLayout;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import javax.swing.BorderFactory;
import javax.swing.Box;
import javax.swing.JComponent;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JSlider;
import javax.swing.JTextArea;
import kg.core.Interface;
import kg.core.Profile;
import kg.core.SafeFiles;
import kg.core.Trace;
import kg.core.Vector;
import kg.gates.Requirements;
import kg.harness.Memory;
import kg.harness.Skills;
import kg.sil.Plant;

/** All pages. Each is rebuilt from files on disk when shown, so it always reflects the evidence. */
final class Pages {
    private Pages() {
    }

    /* ------------------------------------------------------------ live run model */

    /** State of the run currently streaming from the CLI. */
    static final class Live {
        String title = "";
        String runId = "";
        boolean active;
        Integer exit;
        String verdict;
        String reason = "";
        final Map<String, String[]> agents = new LinkedHashMap<>();
        final List<String[]> gates = new ArrayList<>();
        final List<String> lines = new ArrayList<>();
        Instant started = Instant.now();
        transient Runnable onChange;

        void reset(String t) {
            title = t;
            runId = "";
            active = true;
            exit = null;
            verdict = null;
            reason = "";
            agents.clear();
            gates.clear();
            lines.clear();
            started = Instant.now();
            changed();
        }

        void accept(Runner.Event e) {
            String[] f = e.f();
            switch (e.kind()) {
                case "run" -> runId = f.length > 1 ? f[1] : "";
                case "agent" -> {
                    if (f.length >= 4) {
                        agents.put(f[1], new String[] {f[2], f[3], f.length > 4 ? f[4] : "", f.length > 5 ? f[5] : ""});
                    }
                }
                case "gate" -> {
                    if (f.length >= 4) {
                        gates.add(new String[] {f[1], f[2], f[3]});
                    }
                }
                case "verdict" -> {
                    verdict = f.length > 1 ? f[1] : null;
                    reason = f.length > 2 ? f[2] : "";
                }
                case "check" -> verdict = f.length > 1 ? f[1] : null;
                case "eval" -> verdict = f.length > 1 ? f[1] : null;
                case "text" -> {
                    if (!f[1].isBlank()) {
                        lines.add(f[1]);
                    }
                }
                default -> lines.add(e.raw().substring(3).replace('|', ' '));
            }
            while (lines.size() > 400) {
                lines.remove(0);
            }
            changed();
        }

        void finish(int code) {
            active = false;
            exit = code;
            changed();
        }

        private void changed() {
            if (onChange != null) {
                onChange.run();
            }
        }
    }

    /* ------------------------------------------------------------ helpers */

    static JComponent page(String title, String subtitle, JComponent body) {
        Theme t = Ui.t;
        JPanel col = Ui.column();
        col.setBorder(BorderFactory.createEmptyBorder(t.px(26), t.px(32), t.px(32), t.px(32)));
        col.add(Ui.left(Ui.h1(title)));
        if (subtitle != null) {
            col.add(Ui.gap(4));
            col.add(Ui.left(Ui.muted(subtitle)));
        }
        col.add(Ui.gap(20));
        body.setAlignmentX(Component.LEFT_ALIGNMENT);
        col.add(body);
        Fit wrap = new Fit();
        wrap.add(col, BorderLayout.NORTH);
        javax.swing.JScrollPane sp = Ui.scroll(wrap);
        sp.setHorizontalScrollBarPolicy(javax.swing.JScrollPane.HORIZONTAL_SCROLLBAR_NEVER);
        javax.swing.SwingUtilities.invokeLater(() -> sp.getViewport().setViewPosition(new java.awt.Point(0, 0)));
        return sp;
    }

    /** Page body that always matches the window width, so nothing is cut off on the right. */
    static final class Fit extends JPanel implements javax.swing.Scrollable {
        private static final long serialVersionUID = 1L;

        Fit() {
            super(new BorderLayout());
            setOpaque(false);
        }

        @Override
        public Dimension getPreferredScrollableViewportSize() {
            return getPreferredSize();
        }

        @Override
        public int getScrollableUnitIncrement(java.awt.Rectangle r, int o, int d) {
            return Ui.t.px(24);
        }

        @Override
        public int getScrollableBlockIncrement(java.awt.Rectangle r, int o, int d) {
            return r.height - Ui.t.px(40);
        }

        @Override
        public boolean getScrollableTracksViewportWidth() {
            return true;
        }

        @Override
        public boolean getScrollableTracksViewportHeight() {
            return false;
        }
    }

    static JComponent message(String title, String text) {
        return page(title, null, Ui.textBlock(text, false));
    }

    static Ui.Card card(String title, JComponent body) {
        Ui.Card c = new Ui.Card();
        JPanel in = new JPanel(new BorderLayout(0, Ui.t.px(10)));
        in.setOpaque(false);
        if (title != null) {
            in.add(Ui.h2(title), BorderLayout.NORTH);
        }
        in.add(body, BorderLayout.CENTER);
        c.add(in);
        return c;
    }

    static JComponent stat(String label, String value, String status) {
        Theme t = Ui.t;
        Ui.Card c = new Ui.Card();
        JPanel p = Ui.column();
        p.add(Ui.left(Ui.muted(label)));
        p.add(Ui.gap(6));
        JLabel v = Ui.label(value, 22f, Font.BOLD, status == null ? t.text : t.status(status));
        p.add(Ui.left(v));
        c.add(p);
        return c;
    }

    static String ago(Instant i) {
        Duration d = Duration.between(i, Instant.now());
        if (d.toMinutes() < 1) {
            return "just now";
        }
        if (d.toHours() < 1) {
            return d.toMinutes() + " min ago";
        }
        if (d.toDays() < 1) {
            return d.toHours() + " h ago";
        }
        return d.toDays() + " d ago";
    }

    /** One line in a list: left text, optional muted detail, right pill. */
    static JComponent listRow(String main, String detail, String status, Runnable click) {
        Theme t = Ui.t;
        JPanel r = new JPanel(new BorderLayout(t.px(12), 0)) {
            private static final long serialVersionUID = 1L;
            private final transient Ui.Anim h = new Ui.Anim(this, 0f);

            {
                if (click != null) {
                    setCursor(java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR));
                    addMouseListener(new java.awt.event.MouseAdapter() {
                        @Override
                        public void mouseEntered(java.awt.event.MouseEvent e) {
                            h.to(1f);
                        }

                        @Override
                        public void mouseExited(java.awt.event.MouseEvent e) {
                            h.to(0f);
                        }

                        @Override
                        public void mouseClicked(java.awt.event.MouseEvent e) {
                            click.run();
                        }
                    });
                }
            }

            @Override
            protected void paintComponent(Graphics g0) {
                Graphics2D g = (Graphics2D) g0.create();
                Ui.hints(g);
                g.setColor(Theme.mix(t.surface, t.hover, h.value));
                g.fillRoundRect(0, 0, getWidth(), getHeight(), t.px(10), t.px(10));
                g.dispose();
            }
        };
        r.setOpaque(false);
        r.setBorder(BorderFactory.createEmptyBorder(t.px(9), t.px(10), t.px(9), t.px(10)));
        JPanel txt = Ui.column();
        txt.add(Ui.left(Ui.label(main, 13.5f, Font.BOLD, t.text)));
        if (detail != null && !detail.isEmpty()) {
            JLabel d = Ui.muted(detail);
            txt.add(Ui.left(d));
        }
        r.add(txt, BorderLayout.CENTER);
        if (status != null) {
            JPanel s = new JPanel(new java.awt.GridBagLayout());
            s.setOpaque(false);
            s.add(Ui.status(status));
            r.add(s, BorderLayout.EAST);
        }
        r.setMaximumSize(new Dimension(Integer.MAX_VALUE, r.getPreferredSize().height));
        r.setAlignmentX(Component.LEFT_ALIGNMENT);
        return r;
    }

    static JPanel grid(int cols, JComponent... items) {
        JPanel g = new JPanel(new GridLayout(0, cols, Ui.t.px(14), Ui.t.px(14)));
        g.setOpaque(false);
        for (JComponent c : items) {
            g.add(c);
        }
        return g;
    }

    /* ------------------------------------------------------------ welcome */

    static JComponent welcome(App app) {
        Theme t = Ui.t;
        JPanel col = Ui.column();
        col.add(Ui.left(Ui.muted("Kindgleam checks embedded firmware in simulation (SIL), on a board over USB (PIL)"
                + " and on real hardware (HIL). Open a project folder to begin.")));
        col.add(Ui.gap(16));
        JPanel b = Ui.row(t.px(10));
        Ui.Btn open = new Ui.Btn("Open project", Ui.Kind.PRIMARY);
        open.addActionListener(e -> app.chooseProject());
        b.add(open);
        String[][] ex = {{"Heater example", "1"}, {"Valve example", "2"}};
        for (String[] x : ex) {
            Ui.Btn btn = new Ui.Btn("Try the " + x[0].toLowerCase(java.util.Locale.ROOT), Ui.Kind.SECONDARY);
            btn.addActionListener(e -> {
                // examples ship read-only with the app; work on your own copy in your projects folder
                Path mine = NewProject.defaultRoot().resolve(x[0]);
                try {
                    if (!Files.isDirectory(mine)) {
                        Files.createDirectories(NewProject.defaultRoot());
                        mine = NewProject.create(app.home, NewProject.defaultRoot(), x[0], Integer.parseInt(x[1]));
                    }
                    app.openProject(mine, true);
                } catch (java.io.IOException | kg.core.InputException | java.security.GeneralSecurityException ex2) {
                    app.toast("Could not create the example: " + ex2.getMessage(), "FAIL");
                }
            });
            b.add(btn);
        }
        col.add(Ui.left(b));
        if (!app.settings.recent.isEmpty()) {
            col.add(Ui.gap(26));
            col.add(Ui.left(Ui.h2("Recent")));
            col.add(Ui.gap(8));
            for (String r : app.settings.recent) {
                Path p = Path.of(r);
                col.add(listRow(p.getFileName().toString(), r, null, () -> app.openProject(p, true)));
            }
        }
        return page("Welcome", null, col);
    }

    /* ------------------------------------------------------------ overview */

    static JComponent overview(App app) {
        ProjectData d = app.data;
        Interface itf = d.itf();
        List<ProjectData.Run> runs = d.runs();
        ProjectData.Run lastVerify = runs.stream().filter(r -> r.verdict() != null).findFirst().orElse(null);
        ProjectData.Run last = runs.isEmpty() ? null : runs.get(0);
        int reqs = d.requirements().size();
        int vecs = d.vectorNames().size();

        JPanel col = Ui.column();
        col.add(grid(4,
                stat("Last verdict", lastVerify == null ? "none yet" : lastVerify.verdict(), lastVerify == null ? null : lastVerify.verdict()),
                stat("Requirements", String.valueOf(reqs), null),
                stat("Test vectors", String.valueOf(vecs), null),
                stat("Runs", String.valueOf(runs.size()), null)));
        col.add(Ui.gap(16));

        JPanel two = grid(2);
        JPanel itfBody = Ui.column();
        if (itf == null) {
            itfBody.add(Ui.left(Ui.muted("interface.cfg is missing or invalid; run Check to see why.")));
        } else {
            itfBody.add(Ui.left(Ui.muted(itf.name + " at " + itf.rateHz + " Hz, timing budget " + itf.timingBudgetUs + " us")));
            itfBody.add(Ui.gap(8));
            for (Interface.Input in : itf.inputs) {
                itfBody.add(listRow(in.name(), "input " + in.source().toString().toLowerCase(Locale.ROOT) + ", " + in.min() + " .. "
                        + in.max() + " " + in.unit(), null, null));
            }
            for (Interface.Output o : itf.outputs) {
                itfBody.add(listRow(o.name(), "output, " + o.min() + " .. " + o.max() + " " + o.unit() + ", safe value " + o.safe(),
                        null, null));
            }
        }
        two.add(card("Firmware interface", itfBody));

        JPanel act = Ui.column();
        if (last == null) {
            act.add(Ui.left(Ui.muted("No runs yet. Press Check for the fast gates, or Verify for a full verdict.")));
        } else {
            for (ProjectData.Run r : runs.subList(0, Math.min(6, runs.size()))) {
                act.add(listRow(r.kind() + "  " + r.id(), ago(r.when()) + (r.reason().isEmpty() ? "" : "  -  " + r.reason()), r.label(),
                        () -> {
                            app.focusRun = r.id();
                            app.show("Runs");
                        }));
            }
        }
        two.add(card("Recent activity", act));
        col.add(two);

        if (lastVerify != null && !lastVerify.notes().isEmpty()) {
            col.add(Ui.gap(16));
            JPanel n = Ui.column();
            for (String s : lastVerify.notes()) {
                n.add(Ui.left(Ui.muted("-  " + s)));
            }
            col.add(card("Notes from the last verdict", n));
        }
        return page(d.name(), "Project overview  -  " + d.project, col);
    }

    /* ------------------------------------------------------------ runs */

    static JComponent runs(App app) {
        Theme t = Ui.t;
        ProjectData d = app.data;
        List<ProjectData.Run> runs = d.runs();
        JPanel split = new JPanel(new BorderLayout(t.px(16), 0));
        split.setOpaque(false);

        JPanel list = Ui.column();
        Pages.Live live = app.live;
        if (live.active || live.exit != null) {
            list.add(listRow(live.title, live.active ? "streaming..." : "this session", live.active ? "RUNNING"
                    : (live.verdict != null ? live.verdict : (live.exit == 0 ? "OK" : "FAIL")), () -> {
                        app.focusRun = "@live";
                        app.show("Runs");
                    }));
            list.add(Ui.gap(6));
        }
        for (ProjectData.Run r : runs) {
            list.add(listRow(r.kind() + "  " + r.id(), ago(r.when()), r.label(), () -> {
                app.focusRun = r.id();
                app.show("Runs");
            }));
        }
        if (runs.isEmpty() && !live.active && live.exit == null) {
            list.add(Ui.left(Ui.muted("No runs yet.")));
        }
        Ui.Card lc = card("History", list);
        lc.setPreferredSize(new Dimension(t.px(300), 10));
        split.add(lc, BorderLayout.WEST);

        JComponent detail;
        boolean showLive = live.active || "@live".equals(app.focusRun) || (app.focusRun == null && live.exit != null)
                || (live.exit != null && live.runId.equals(app.focusRun) && false);
        if (showLive) {
            detail = liveView(app);
        } else {
            ProjectData.Run r = null;
            for (ProjectData.Run x : runs) {
                if (x.id().equals(app.focusRun)) {
                    r = x;
                }
            }
            if (r == null && !runs.isEmpty()) {
                r = runs.get(0);
            }
            detail = r == null ? Ui.muted("Select a run.") : runDetail(app, r);
        }
        split.add(detail, BorderLayout.CENTER);
        return page("Runs", "Every check, verify and eval, newest first. Results come from the run folder, never from the app.", split);
    }

    private static JComponent liveView(App app) {
        Theme t = Ui.t;
        Live live = app.live;
        JPanel col = Ui.column();
        Timeline tl = new Timeline(live);
        col.add(tl);
        col.add(Ui.gap(12));
        JPanel gates = Ui.column();
        col.add(card("Gates", gates));
        col.add(Ui.gap(12));
        JTextArea log = Ui.textBlock("", true);
        log.setRows(12);
        col.add(card("Output", Ui.scroll(log)));
        Runnable refresh = () -> {
            tl.repaint();
            gates.removeAll();
            for (String[] g : live.gates) {
                gates.add(listRow(g[0], g[2], g[1], null));
            }
            if (live.gates.isEmpty()) {
                gates.add(Ui.left(Ui.muted(live.active ? "waiting for the first gate..." : "no gates reported")));
            }
            gates.revalidate();
            log.setText(String.join("\n", live.lines));
            log.setCaretPosition(log.getDocument().getLength());
            app.refreshBadges();
        };
        live.onChange = () -> {
            if (col.isShowing()) {
                refresh.run();
            }
        };
        refresh.run();
        Ui.Card head = card(null, headLine(live.title + (live.runId.isEmpty() ? "" : "  -  " + live.runId),
                live.active ? "RUNNING" : (live.verdict != null ? live.verdict : "DONE"), live.reason));
        JPanel outer = Ui.column();
        outer.add(head);
        outer.add(Ui.gap(12));
        outer.add(col);
        return outer;
    }

    private static JComponent headLine(String title, String status, String reason) {
        JPanel p = new JPanel(new BorderLayout(Ui.t.px(10), 0));
        p.setOpaque(false);
        JPanel c = Ui.column();
        c.add(Ui.left(Ui.h2(title)));
        if (reason != null && !reason.isEmpty()) {
            c.add(Ui.left(Ui.muted(reason)));
        }
        p.add(c, BorderLayout.CENTER);
        JPanel s = new JPanel(new java.awt.GridBagLayout());
        s.setOpaque(false);
        s.add(Ui.status(status));
        p.add(s, BorderLayout.EAST);
        return p;
    }

    /** Animated horizontal agent timeline. */
    static final class Timeline extends JComponent {
        private static final long serialVersionUID = 1L;
        private final transient Live live;
        private final javax.swing.Timer pulse;
        private float phase;

        Timeline(Live live) {
            this.live = live;
            pulse = new javax.swing.Timer(40, e -> {
                phase += 0.08f;
                if (live.active) {
                    repaint();
                }
            });
            pulse.start();
            setAlignmentX(Component.LEFT_ALIGNMENT);
        }

        @Override
        public void removeNotify() {
            pulse.stop();
            super.removeNotify();
        }

        @Override
        public void addNotify() {
            super.addNotify();
            pulse.start();
        }

        @Override
        public Dimension getPreferredSize() {
            return new Dimension(Ui.t.px(600), Ui.t.px(86));
        }

        @Override
        public Dimension getMaximumSize() {
            return new Dimension(Integer.MAX_VALUE, Ui.t.px(86));
        }

        @Override
        protected void paintComponent(Graphics g0) {
            Theme t = Ui.t;
            Graphics2D g = (Graphics2D) g0.create();
            Ui.hints(g);
            g.setColor(t.surface);
            g.fillRoundRect(0, 0, getWidth(), getHeight(), t.px(14), t.px(14));
            g.setColor(t.border);
            g.drawRoundRect(0, 0, getWidth() - 1, getHeight() - 1, t.px(14), t.px(14));
            List<String[]> a = new ArrayList<>(live.agents.values());
            if (a.isEmpty()) {
                g.setColor(t.muted);
                g.setFont(t.size(13f, Font.PLAIN));
                g.drawString(live.active ? "starting..." : "no agents ran", t.px(18), getHeight() / 2 + t.px(4));
                g.dispose();
                return;
            }
            int n = a.size();
            int pad = t.px(24);
            int w = getWidth() - 2 * pad;
            int cy = t.px(32);
            g.setColor(t.border);
            g.fillRect(pad, cy - 1, w, 2);
            g.setFont(t.size(10.5f, Font.PLAIN));
            FontMetrics fm = g.getFontMetrics();
            for (int i = 0; i < n; i++) {
                String[] s = a.get(i);
                int x = pad + (n == 1 ? w / 2 : i * w / (n - 1));
                String st = s[1];
                Color c = t.status(st.equals("START") ? "RUNNING" : st);
                int r = t.px(7);
                if (st.equals("START")) {
                    float k = (float) (0.5 + 0.5 * Math.sin(phase * 3));
                    g.setColor(Theme.mix(t.surface, c, 0.25f + 0.3f * k));
                    int rr = r + Math.round(t.px(5) * k);
                    g.fillOval(x - rr, cy - rr, 2 * rr, 2 * rr);
                }
                g.setColor(c);
                g.fillOval(x - r, cy - r, 2 * r, 2 * r);
                g.setColor(t.muted);
                String lab = s[0];
                if (n > 10 && i % 2 == 1) {
                    g.drawString(lab, x - fm.stringWidth(lab) / 2, cy + t.px(36));
                } else {
                    g.drawString(lab, x - fm.stringWidth(lab) / 2, cy + t.px(22));
                }
            }
            g.dispose();
        }
    }

    private static JComponent runDetail(App app, ProjectData.Run r) {
        Theme t = Ui.t;
        JPanel col = Ui.column();
        col.add(card(null, headLine(r.kind() + "  " + r.id(), r.label(), r.reason())));
        col.add(Ui.gap(12));
        JPanel ag = Ui.column();
        for (ProjectData.Agent a : r.agents()) {
            ag.add(listRow(a.no() + "  " + a.name(), (a.ms().isEmpty() ? "" : a.ms() + " ms") + (a.reason().isEmpty() ? "" : "  -  "
                    + a.reason()), a.status(), null));
        }
        if (r.agents().isEmpty()) {
            ag.add(Ui.left(Ui.muted("no agent reports in this run")));
        }
        JPanel gs = Ui.column();
        for (ProjectData.Gate g : r.gates()) {
            gs.add(listRow(g.id(), g.detail(), g.pass() ? "PASS" : "FAIL", null));
        }
        if (r.gates().isEmpty()) {
            gs.add(Ui.left(Ui.muted("no gates recorded")));
        }
        JPanel two = grid(2, card("Agents", ag), card("Gates", gs));
        col.add(two);
        JComponent margins = marginsCard(app, r.id());
        if (margins != null) {
            col.add(Ui.gap(12));
            col.add(margins);
        }
        Map<String, String> vr = app.data.vectorResults(r.id());
        if (!vr.isEmpty()) {
            col.add(Ui.gap(12));
            JPanel vs = Ui.column();
            vr.keySet().stream().sorted().forEach(v -> vs.add(listRow(v, "open in oscilloscope", vr.get(v), () -> {
                app.focusRun = r.id();
                app.focusVector = v;
                app.show("Oscilloscope");
            })));
            col.add(card("Vectors", vs));
        }
        if (!r.report().isEmpty()) {
            col.add(Ui.gap(12));
            JTextArea rep = Ui.textBlock(r.report(), true);
            col.add(card("Report", rep));
        }
        col.setBorder(BorderFactory.createEmptyBorder(0, 0, t.px(4), 0));
        return col;
    }

    /* ------------------------------------------------------------ oscilloscope */

    static JComponent scope(App app) {
        Theme t = Ui.t;
        ProjectData d = app.data;
        Interface itf = d.itf();
        Plant.Spec plant = d.plant(itf);
        if (itf == null || plant == null) {
            return message("Oscilloscope", "The interface or plant model could not be loaded. Run Check to see why.");
        }
        List<ProjectData.Run> runs = d.runs().stream().filter(r -> !r.isEval()).toList();
        String run = app.focusRun != null && !app.focusRun.startsWith("@") ? app.focusRun : null;
        if (run == null) {
            for (ProjectData.Run r : runs) {
                if (Files.isDirectory(d.project.resolve("jobs").resolve(r.id()).resolve("traces"))) {
                    run = r.id();
                    break;
                }
            }
        }
        List<String> names = d.vectorNames(run);
        if (run == null || names.isEmpty()) {
            return message("Oscilloscope", "No traces yet. Run Verify to record SIL (and PIL) traces, then come back here.");
        }
        Map<String, String> units = new HashMap<>();
        for (Interface.Input in : itf.inputs) {
            units.put(in.name(), in.unit());
        }
        for (Interface.Output o : itf.outputs) {
            units.put(o.name(), o.unit());
        }
        for (Plant.Out o : plant.outputs) {
            units.put(o.name(), o.unit());
        }
        units.put("wd", "flag");

        String vec = app.focusVector != null && names.contains(app.focusVector) ? app.focusVector : names.get(0);
        ScopeView sv = new ScopeView();
        sv.setPreferredSize(new Dimension(t.px(800), t.px(520)));
        Map<String, String> res = d.vectorResults(run);
        String fRun = run;
        JPanel chooser = Ui.column();
        JLabel title = Ui.h2("");
        JTextArea src = Ui.textBlock("", true);
        Runnable[] load = new Runnable[1];
        load[0] = () -> {
            String v = app.focusVector != null && names.contains(app.focusVector) ? app.focusVector : names.get(0);
            Trace sil = d.trace(fRun, v, ".trace");
            Trace pil = d.trace(fRun, v, ".pil");
            Vector vv = d.vector(v, itf, plant, fRun);
            title.setText(v + "  -  " + fRun + (pil != null ? "  (SIL solid, PIL dashed)" : "  (SIL)"));
            src.setText((d.generated(v) ? "# generated by a Python script in tests/ for run " + fRun + "\n" : "") + d.vectorText(v, fRun));
            sv.show(v, sil, pil, vv, units);
            sv.focusFault();
        };
        app.focusVector = vec;
        for (String n : names) {
            chooser.add(listRow(n, d.generated(n) ? "generated" : null, res.get(n), () -> {
                app.focusVector = n;
                load[0].run();
            }));
        }
        load[0].run();
        Ui.Card list = card("Vectors", chooser);
        list.setPreferredSize(new Dimension(t.px(240), 10));
        JPanel main = new JPanel(new BorderLayout(t.px(16), 0));
        main.setOpaque(false);
        main.add(list, BorderLayout.WEST);
        JPanel right = Ui.column();
        Ui.Card sc = new Ui.Card();
        JPanel scIn = new JPanel(new BorderLayout(0, t.px(8)));
        scIn.setOpaque(false);
        scIn.add(title, BorderLayout.NORTH);
        scIn.add(sv, BorderLayout.CENTER);
        JPanel tools = Ui.row(t.px(8));
        Ui.Btn fault = new Ui.Btn("Zoom to event", Ui.Kind.SECONDARY);
        fault.addActionListener(e -> sv.focusFault());
        tools.add(fault);
        tools.add(Ui.muted("Wheel to zoom, drag to pan, click chips to hide signals, double-click to reset."));
        scIn.add(tools, BorderLayout.SOUTH);
        sc.add(scIn);
        right.add(sc);
        right.add(Ui.gap(12));
        right.add(card("Vector source", src));
        main.add(right, BorderLayout.CENTER);
        return page("Oscilloscope", "Recorded traces from run " + run + ". Simulated probes only; nothing here touches hardware.", main);
    }

    /* ------------------------------------------------------------ requirements */

    static JComponent requirements(App app) {
        ProjectData d = app.data;
        Interface itf = d.itf();
        Plant.Spec plant = d.plant(itf);
        List<Requirements.Req> reqs = d.requirements();
        Map<String, List<String>> byReq = new LinkedHashMap<>();
        List<ProjectData.Run> verdictRuns = d.runs().stream().filter(r -> r.verdict() != null).toList();
        String lastRun = verdictRuns.isEmpty() ? null : verdictRuns.get(0).id();
        if (itf != null && plant != null) {
            for (String n : d.vectorNames(lastRun)) {
                Vector v = d.vector(n, itf, plant, lastRun);
                if (v != null) {
                    byReq.computeIfAbsent(v.req, k -> new ArrayList<>()).add(n);
                }
            }
        }
        List<ProjectData.Run> runs = d.runs();
        Map<String, String> res = runs.stream().filter(r -> r.verdict() != null).findFirst()
                .map(r -> d.vectorResults(r.id())).orElse(Map.of());
        JPanel col = Ui.column();
        for (Requirements.Req r : reqs) {
            List<String> vs = byReq.getOrDefault(r.id(), List.of());
            String st = vs.isEmpty() ? "FAIL" : vs.stream().allMatch(v -> "PASS".equals(res.get(v))) ? "PASS"
                    : vs.stream().anyMatch(v -> "FAIL".equals(res.get(v))) ? "FAIL" : "-";
            String det = r.text() + "\n";
            JPanel c = Ui.column();
            c.add(Ui.left(Ui.muted(String.join(", ", r.tiers()).toUpperCase(Locale.ROOT) + "   tested by: "
                    + (vs.isEmpty() ? "nothing (G5 will fail)" : String.join(", ", vs)))));
            c.add(Ui.gap(4));
            JTextArea txt = Ui.textBlock(det.strip(), false);
            c.add(Ui.left(txt));
            Ui.Card card = card(null, c);
            JPanel head = new JPanel(new BorderLayout());
            head.setOpaque(false);
            head.add(Ui.h2(r.id()), BorderLayout.WEST);
            JPanel s = new JPanel(new java.awt.GridBagLayout());
            s.setOpaque(false);
            s.add(Ui.status(st));
            head.add(s, BorderLayout.EAST);
            ((JPanel) card.getComponent(0)).add(head, BorderLayout.NORTH);
            col.add(card);
            col.add(Ui.gap(10));
        }
        if (reqs.isEmpty()) {
            col.add(Ui.left(Ui.muted("spec/spec.req is missing or has no requirements.")));
        }
        return page("Requirements", reqs.size() + " requirements from spec/spec.req; status from the last verdict run.", col);
    }

    /* ------------------------------------------------------------ evidence */

    static JComponent evidence(App app) {
        ProjectData d = app.data;
        JPanel col = Ui.column();
        List<String> l = d.ledgerLines();
        JPanel ledger = Ui.column();
        for (String s : l.subList(0, Math.min(200, l.size()))) {
            ledger.add(Ui.left(Ui.label(s, 12f, Font.PLAIN, Ui.t.text)));
        }
        if (l.isEmpty()) {
            ledger.add(Ui.left(Ui.muted("No ledger entries yet. Each Verify appends one signed, hash-chained entry.")));
        }
        JPanel act = Ui.row(Ui.t.px(8));
        Ui.Btn verify = new Ui.Btn("Verify ledger chain", Ui.Kind.SECONDARY, "shield");
        JLabel out = Ui.muted("");
        verify.addActionListener(e -> {
            Pages.Live tmp = new Pages.Live();
            StringBuilder sb = new StringBuilder();
            try {
                new Runner(app.home).start(d.project, List.of("ledger-verify"), ev -> sb.append(ev.raw()).append(' '), code -> {
                    out.setText(code == 0 ? "Chain and signatures verified." : "Ledger check FAILED: " + sb);
                    app.toast(code == 0 ? "Ledger verified" : "Ledger check failed", code == 0 ? "PASS" : "FAIL");
                });
            } catch (java.io.IOException ex) {
                out.setText(ex.getMessage());
            }
            tmp.reset("");
        });
        act.add(verify);
        act.add(out);
        col.add(Ui.left(act));
        col.add(Ui.gap(12));
        col.add(card("Ledger (newest first)", ledger));
        return page("Evidence", "Signed, hash-chained record of every verdict. The app only reads it.", col);
    }

    /* ------------------------------------------------------------ memory */

    static JComponent memory(App app) {
        Path p = app.data.project;
        JPanel col = Ui.column();
        for (String log : Memory.LOGS) {
            JPanel body = Ui.column();
            try {
                List<String> items = Memory.list(p, log);
                List<String> bad = Memory.verify(p, log);
                if (!bad.isEmpty()) {
                    body.add(Ui.left(Ui.label("Integrity problem: " + String.join("; ", bad), 12.5f, Font.BOLD, Ui.t.fail)));
                }
                for (int i = items.size() - 1; i >= Math.max(0, items.size() - 30); i--) {
                    body.add(Ui.left(Ui.label(items.get(i), 12.5f, Font.PLAIN, Ui.t.text)));
                }
                if (items.isEmpty()) {
                    body.add(Ui.left(Ui.muted("empty")));
                }
            } catch (kg.core.InputException e) {
                body.add(Ui.left(Ui.muted(e.getMessage())));
            }
            col.add(card(log.replace('_', ' '), body));
            col.add(Ui.gap(10));
        }
        JPanel add = Ui.column();
        javax.swing.JTextField f = new javax.swing.JTextField();
        f.setFont(Ui.t.size(13f, Font.PLAIN));
        Ui.Btn b = new Ui.Btn("Record decision", Ui.Kind.PRIMARY);
        b.addActionListener(e -> {
            String s = f.getText().strip();
            if (s.isEmpty()) {
                return;
            }
            try {
                Memory.add(p, "decisions", "app", s);
                app.toast("Decision recorded", "OK");
                app.show("Memory");
            } catch (kg.core.InputException | java.io.IOException ex) {
                app.toast(ex.getMessage(), "FAIL");
            }
        });
        add.add(Ui.left(f));
        add.add(Ui.gap(8));
        add.add(Ui.left(b));
        col.add(card("Add a decision", add));
        return page("Memory", "Project memory: append-only, hash-chained logs. Memory informs people, never a gate.", col);
    }

    /* ------------------------------------------------------------ skills */

    static JComponent skills(App app) {
        JPanel col = Ui.column();
        try {
            for (String n : Skills.names(app.home)) {
                JTextArea body = Ui.textBlock(String.join("\n", Skills.show(app.home, n)), false);
                col.add(card(n, body));
                col.add(Ui.gap(10));
            }
        } catch (java.io.IOException | kg.core.InputException e) {
            col.add(Ui.left(Ui.muted("Skills could not be read: " + e.getMessage())));
        }
        return page("Skills", "Fixed, reviewed procedures the agents follow. Read-only here.", col);
    }

    /* ------------------------------------------------------------ settings */

    static JComponent settings(App app) {
        Theme t = Ui.t;
        AppSettings s = app.settings;
        JPanel col = Ui.column();

        JPanel look = Ui.column();
        Widgets.Switch dark = new Widgets.Switch(s.dark);
        dark.onChange(v -> app.setTheme(v));
        look.add(settingRow("Dark theme", "Easier on the eyes in a lab.", dark));
        Widgets.Switch motion = new Widgets.Switch(s.reduceMotion);
        motion.onChange(v -> {
            s.reduceMotion = v;
            Ui.reduceMotion = v;
            s.save();
        });
        look.add(settingRow("Reduce motion", "Turns off animations.", motion));
        JSlider scale = new JSlider(80, 160, Math.round(s.scale * 100));
        scale.setOpaque(false);
        scale.setPreferredSize(new Dimension(t.px(200), t.px(30)));
        JLabel sv = Ui.muted(Math.round(s.scale * 100) + "%");
        scale.addChangeListener(e -> {
            sv.setText(scale.getValue() + "%");
            if (!scale.getValueIsAdjusting()) {
                app.setScale(scale.getValue() / 100f);
            }
        });
        JPanel sc = Ui.row(t.px(8));
        sc.add(scale);
        sc.add(sv);
        look.add(settingRow("Interface size", "Scales text and controls.", sc));
        col.add(card("Appearance", look));
        col.add(Ui.gap(12));

        JPanel runs = Ui.column();
        Widgets.Segmented tier = new Widgets.Segmented(new String[] {"SIL", "PIL", "HIL"}, s.defaultTier);
        tier.onChange(v -> {
            s.defaultTier = v.toLowerCase(Locale.ROOT);
            s.save();
        });
        runs.add(settingRow("Default tier", "Tier preselected in the header.", tier));
        Widgets.Switch hil = new Widgets.Switch(s.confirmHil);
        hil.onChange(v -> {
            s.confirmHil = v;
            s.save();
        });
        runs.add(settingRow("Confirm before HIL", "Ask before any run that drives real hardware.", hil));
        Widgets.Switch asst = new Widgets.Switch(s.assistantEnabled);
        asst.onChange(v -> {
            if (v && !acceptUse(app)) {
                asst.set(false);
                return;
            }
            s.assistantEnabled = v;
            s.save();
        });
        runs.add(settingRow("Coding assistant", "Local, offline; off by default. Its code goes through every gate and it has no say in any verdict.", asst));
        Widgets.Switch auto = new Widgets.Switch(s.autoReview);
        auto.onChange(v -> {
            s.autoReview = v;
            s.save();
        });
        runs.add(settingRow("Review every run automatically", "After each Check or Verify the assistant reads the results in the "
                + "background and puts suggestions on your code.", auto));
        Widgets.Switch live = new Widgets.Switch(s.liveComplete);
        live.onChange(v -> {
            s.liveComplete = v;
            s.save();
        });
        runs.add(settingRow("Suggest code as you type", "When you pause typing, the assistant offers the next lines in grey. "
                + "Tab accepts, Esc or typing dismisses. Ctrl+Space asks at any time.", live));
        col.add(card("Runs", runs));

        if (app.data != null) {
            col.add(Ui.gap(12));
            col.add(profileEditor(app));
        }
        col.add(Ui.gap(12));
        JPanel sec = Ui.column();
        Ui.Btn reseal = new Ui.Btn("Seal the installed tools", Ui.Kind.SECONDARY, "shield");
        reseal.addActionListener(e -> {
            boolean ok = Dialogs.confirm(app.frame, Dialogs.Kind.WARNING, "Seal the installed tools",
                    "Only do this right after installing or updating Kindgleam.\nSealing records the current tool files as trusted;"
                    + " if they were changed by anyone else, sealing would hide it.", "Seal tools", "Cancel");
            if (ok) {
                app.setupComputer(false);
            }
        });
        sec.add(settingRow("Tool seal", "Kindgleam checks its own files against this seal before every run. Seal again after an update.",
                reseal));
        col.add(card("This computer", sec));
        col.add(Ui.gap(12));
        col.add(card("About", Ui.textBlock("Kindgleam " + "desktop  -  Java " + System.getProperty("java.version") + " on "
                + System.getProperty("os.name") + " " + System.getProperty("os.arch") + "\nHome: " + app.home
                + "\nSettings file: " + AppSettings.file() + "\nThese preferences change how the app looks, never what a gate decides.",
                false)));
        return page("Settings", null, col);
    }

    private static JComponent settingRow(String title, String detail, JComponent control) {
        Theme t = Ui.t;
        JPanel r = new JPanel(new BorderLayout(t.px(16), 0));
        r.setOpaque(false);
        r.setBorder(BorderFactory.createEmptyBorder(t.px(8), 0, t.px(8), 0));
        JPanel c = Ui.column();
        c.add(Ui.left(Ui.label(title, 13.5f, Font.BOLD, t.text)));
        c.add(Ui.left(Ui.muted(detail)));
        r.add(c, BorderLayout.CENTER);
        JPanel w = new JPanel(new java.awt.GridBagLayout());
        w.setOpaque(false);
        w.add(control);
        r.add(w, BorderLayout.EAST);
        r.setAlignmentX(Component.LEFT_ALIGNMENT);
        r.setMaximumSize(new Dimension(Integer.MAX_VALUE, r.getPreferredSize().height));
        return r;
    }

    /** Edits profile.cfg; the text must pass the same Profile parser the CLI uses before it is saved. */
    private static JComponent profileEditor(App app) {
        Theme t = Ui.t;
        Path proj = app.data.project;
        JTextArea ed = Ui.textBlock(app.data.profileText(), true);
        ed.setEditable(true);
        ed.setRows(14);
        ed.setBackground(t.surface2);
        ed.setBorder(BorderFactory.createEmptyBorder(t.px(10), t.px(12), t.px(10), t.px(12)));
        JLabel status = Ui.muted("Changes are checked by the same parser the CLI uses, and recorded as a memory decision.");
        JTextArea why = Ui.textBlock("", false);
        why.setEditable(true);
        why.setBackground(t.surface2);
        why.setRows(2);
        Ui.Btn save = new Ui.Btn("Validate and save", Ui.Kind.PRIMARY);
        save.addActionListener(e -> {
            String reason = why.getText().strip();
            if (reason.length() < 5) {
                status.setForeground(t.fail);
                status.setText("Write a short reason for the change first (kept in memory/decisions).");
                return;
            }
            Path tmp = null;
            try {
                tmp = Files.createTempFile(proj, ".profile-edit", ".cfg");
                Files.writeString(tmp, ed.getText().strip() + "\n");
                Profile.load(tmp);
                String before = app.data.profileText();
                SafeFiles.writeAtomic(proj.resolve("profile.cfg"), ed.getText().strip() + "\n");
                Memory.add(proj, "decisions", "app", "profile.cfg changed: " + reason + " (was " + before.length() + " chars, now "
                        + ed.getText().strip().length() + ")");
                status.setForeground(t.pass);
                status.setText("Saved. The next run records the new profile hash in the evidence.");
                app.toast("Profile saved", "OK");
            } catch (kg.core.InputException ex) {
                status.setForeground(t.fail);
                status.setText("Not saved: " + ex.getMessage());
            } catch (java.io.IOException ex) {
                status.setForeground(t.fail);
                status.setText("Not saved: " + ex.getMessage());
            } finally {
                if (tmp != null) {
                    try {
                        Files.deleteIfExists(tmp);
                    } catch (java.io.IOException ex) {
                        // temp file cleanup best effort
                    }
                }
            }
        });
        JPanel body = Ui.column();
        body.add(Ui.left(ed));
        body.add(Ui.gap(8));
        body.add(Ui.left(Ui.muted("Reason for change")));
        body.add(Ui.left(why));
        body.add(Ui.gap(8));
        JPanel r = Ui.row(t.px(10));
        r.add(save);
        r.add(status);
        body.add(Ui.left(r));
        body.add(Box.createVerticalStrut(1));
        return card("Project profile (profile.cfg)", body);
    }

    static final String USE_POLICY = """
            Kindgleam coding assistant - acceptable use

            The assistant is for developing and testing the embedded firmware in your Kindgleam projects.
            By turning it on you agree to use it only for lawful, ethical engineering work, and not to use it,
            or code it writes, to:
              - build malware, spyware, exploits, backdoors or anything that attacks other systems;
              - get around licensing, copy protection, authentication or other people's security;
              - disable, weaken or hide safety functions, or cheat emissions, safety or other certification tests;
              - make weapons, or devices for covert tracking or surveillance of people;
              - break any law or regulation that applies to you or your product.

            It runs only on this computer and never uses the network. Every request and reply is kept in the
            project's jobs/ folder and every applied change is recorded in project memory.
            Its proposals are suggestions: you are responsible for reviewing them, and only a Kindgleam Verify
            run produces a verdict. The model is Qwen2.5-Coder-1.5B-Instruct (Apache-2.0), used unchanged.""";

    private static boolean acceptUse(App app) {
        return Dialogs.confirm(app.frame, Dialogs.Kind.INFO, "Turn on the coding assistant", USE_POLICY, "I agree", "Cancel");
    }

    /** How close each requirement came to failing in a run (fixed arithmetic on the traces). */
    static JComponent marginsCard(App app, String run) {
        ProjectData d = app.data;
        Interface itf = d.itf();
        Plant.Spec plant = d.plant(itf);
        if (itf == null || plant == null) {
            return null;
        }
        List<Object[]> rows = new ArrayList<>();
        List<String> never = new ArrayList<>();
        for (String n : d.vectorNames(run)) {
            Trace tr = d.trace(run, n, ".trace");
            Vector v = d.vector(n, itf, plant, run);
            if (tr == null || v == null) {
                continue;
            }
            for (kg.gates.Margins.Margin m : kg.gates.Margins.of(v, tr)) {
                if (!m.informative()) {
                    if (m.neverApplied()) {
                        never.add(v.req + "  " + n + ":  " + m.assertion());
                    }
                    continue;
                }
                if (m.mode() != Vector.Mode.EVENTUALLY && m.worst() == 0.0) {
                    continue;
                }
                double key = m.mode() == Vector.Mode.EVENTUALLY ? (m.tick() < 0 ? -1e9 : m.worst() * 1e-3) : m.worst();
                rows.add(new Object[] {key, v.req + "  " + n, m.assertion() + "  \u2014  " + m.describe(), m.failed() ? "FAIL" : "PASS"});
            }
        }
        if (rows.isEmpty() && never.isEmpty()) {
            return null;
        }
        rows.sort(java.util.Comparator.comparingDouble(x -> (Double) x[0]));
        JPanel body = Ui.column();
        body.add(Ui.left(Ui.muted("Closest to failing first. A small margin means the requirement holds with little room to spare.")));
        body.add(Ui.gap(6));
        for (Object[] r : rows.subList(0, Math.min(8, rows.size()))) {
            body.add(listRow((String) r[1], (String) r[2], (String) r[3], null));
        }
        for (String n : never.subList(0, Math.min(5, never.size()))) {
            body.add(listRow(n, "never applied: the test never created the situation this check guards", "BLOCKED", null));
        }
        return card("Requirement margins", body);
    }
}
