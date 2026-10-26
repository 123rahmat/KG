package kg.app;

import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Dimension;
import java.awt.Font;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import javax.swing.BorderFactory;
import javax.swing.JComboBox;
import javax.swing.JComponent;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JTextArea;
import javax.swing.JTextField;
import javax.swing.JTextPane;
import javax.swing.SwingUtilities;
import javax.swing.text.SimpleAttributeSet;
import javax.swing.text.StyleConstants;
import javax.swing.text.StyledDocument;
import kg.assist.Assistant;
import kg.assist.EngineClient;
import kg.assist.ModelStore;
import kg.gates.Requirements;

/**
 * Assistant page: pick a fixed task, watch the reply stream in, review the checked proposal as a
 * diff, then apply or reject it. Nothing is written to the project until Apply is pressed.
 */
final class AssistPage {
    private AssistPage() {
    }

    /** One engine per app session; started on first use, stopped when the app closes. */
    static EngineClient engine;
    static Assistant.Proposal last;
    static String lastStream = "";
    static boolean busy;
    static Assistant running;

    static void shutdown() {
        if (engine != null) {
            engine.close();
        }
    }

    static JComponent build(App app) {
        Theme t = Ui.t;
        JPanel col = Ui.column();
        ModelStore.Status st = new ModelStore(app.home).status();

        JPanel head = new JPanel(new BorderLayout(t.px(12), 0));
        head.setOpaque(false);
        JPanel hc = Ui.column();
        hc.add(Ui.left(Ui.label("Model", 13.5f, Font.BOLD, t.text)));
        hc.add(Ui.left(Ui.muted(st.message())));
        head.add(hc, BorderLayout.CENTER);
        JPanel hs = new JPanel(new java.awt.GridBagLayout());
        hs.setOpaque(false);
        hs.add(Ui.status(st.ready() ? "READY" : "OFF"));
        head.add(hs, BorderLayout.EAST);
        col.add(Pages.card(null, head));
        col.add(Ui.gap(12));

        if (!app.settings.assistantEnabled) {
            JPanel off = Ui.column();
            off.add(Ui.left(Ui.muted("The assistant is off. Turn it on in Settings; it runs only on this computer and never "
                    + "uses the network.")));
            off.add(Ui.gap(10));
            Ui.Btn go = new Ui.Btn("Open Settings", Ui.Kind.SECONDARY, "gear");
            go.addActionListener(e -> app.show("Settings"));
            off.add(Ui.left(go));
            col.add(Pages.card("Assistant is off", off));
            return Pages.page("Assistant", null, col);
        }
        if (!st.ready()) {
            JPanel nr = Ui.column();
            nr.add(Ui.left(Ui.textBlock(st.message() + "\n\nThe model file must be the published one; "
                    + "Kindgleam checks its fingerprint and refuses anything else.", false)));
            if (st.file() != null && java.nio.file.Files.isRegularFile(st.file())) {
                nr.add(Ui.gap(10));
                Ui.Btn seal = new Ui.Btn("Check and seal the model", Ui.Kind.PRIMARY, "shield");
                JLabel sl = Ui.muted("");
                seal.addActionListener(e -> {
                    seal.setEnabled(false);
                    sl.setText("Reading the whole file to check its fingerprint...");
                    Thread w = new Thread(() -> {
                        String msg;
                        try {
                            new ModelStore(app.home).verifyFully();
                            msg = null;
                        } catch (java.io.IOException | kg.core.InputException ex) {
                            msg = ex.getMessage();
                        }
                        String fm = msg;
                        SwingUtilities.invokeLater(() -> {
                            app.toast(fm == null ? "Model checked and sealed" : "Not sealed: " + fm, fm == null ? "PASS" : "FAIL");
                            app.show("Assistant");
                        });
                    }, "kg-seal");
                    w.setDaemon(true);
                    w.start();
                });
                JPanel r = Ui.row(Ui.t.px(10));
                r.add(seal);
                r.add(sl);
                nr.add(Ui.left(r));
            }
            col.add(Pages.card("Model not ready", nr));
            return Pages.page("Assistant", null, col);
        }

        // ---------------------------------------------------------------- request form
        JPanel form = Ui.column();
        Widgets.Segmented task = new Widgets.Segmented(new String[] {"Fix", "Write", "Explain", "Vector", "Python", "Review"}, "Fix");
        List<String> files = Assistant.firmwareFiles(app.data.project);
        JComboBox<String> file = new JComboBox<>(files.toArray(new String[0]));
        List<String> reqIds = new ArrayList<>();
        for (Requirements.Req r : app.data.requirements()) {
            reqIds.add(r.id());
        }
        JComboBox<String> req = new JComboBox<>(reqIds.toArray(new String[0]));
        for (JComboBox<String> c : List.of(file, req)) {
            c.setFont(t.size(13f, Font.PLAIN));
            c.setBackground(t.surface2);
            c.setForeground(t.text);
            c.setBorder(BorderFactory.createLineBorder(t.border));
            c.setPreferredSize(new Dimension(t.px(220), t.px(32)));
        }
        JTextField note = new JTextField();
        note.setFont(t.size(13f, Font.PLAIN));
        note.setForeground(t.text);
        note.setBackground(t.surface2);
        note.setCaretColor(t.accent);
        note.setBorder(BorderFactory.createEmptyBorder(t.px(8), t.px(10), t.px(8), t.px(10)));
        JLabel hint = Ui.muted("");
        Runnable sync = () -> {
            String v = task.value();
            file.setEnabled(v.equals("Fix") || v.equals("Write") || v.equals("Explain"));
            req.setEnabled(v.equals("Write") || v.equals("Vector") || v.equals("Python"));
            hint.setText(switch (v) {
                case "Fix" -> "Reads the last failed run and proposes a fix to the chosen file, checked by gates G0-G4.";
                case "Write" -> "Updates the chosen file to meet the chosen requirement, checked by gates G0-G4.";
                case "Explain" -> "Explains the chosen file in plain words. Changes nothing.";
                case "Python" -> "Writes a Python generator (tests/gen_*.py) that sweeps the requirement's range; Kindgleam runs it "
                        + "twice in the sandbox and checks every vector it prints.";
                case "Review" -> "Reads the last verify run and suggests improvements to the firmware and the tests. Changes nothing.";
                default -> "Writes a new test vector for the chosen requirement and checks that it parses.";
            });
        };
        task.onChange(v -> sync.run());
        sync.run();
        JPanel r1 = Ui.row(t.px(10));
        r1.add(task);
        form.add(Ui.left(r1));
        form.add(Ui.gap(10));
        JPanel r1b = Ui.row(t.px(10));
        r1b.add(Ui.muted("File"));
        r1b.add(file);
        r1b.add(Ui.muted("Requirement"));
        r1b.add(req);
        form.add(Ui.left(r1b));
        form.add(Ui.gap(6));
        form.add(Ui.left(hint));
        form.add(Ui.gap(10));
        form.add(Ui.left(Ui.muted("Note for the assistant (optional, up to " + kg.assist.Guard.MAX_NOTE + " characters)")));
        form.add(Ui.left(note));
        form.add(Ui.gap(10));
        JPanel r2 = Ui.row(t.px(10));
        Ui.Btn run = new Ui.Btn("Ask", Ui.Kind.PRIMARY, "spark");
        Ui.Btn stop = new Ui.Btn("Stop", Ui.Kind.DANGER);
        JLabel status = Ui.muted(busy ? "working..." : "");
        r2.add(run);
        r2.add(stop);
        r2.add(status);
        stop.setVisible(busy);
        run.setEnabled(!busy);
        form.add(Ui.left(r2));
        col.add(Pages.card("Ask the assistant", form));
        col.add(Ui.gap(12));

        // ---------------------------------------------------------------- live reply
        JTextArea stream = Ui.textBlock(lastStream, true);
        stream.setRows(10);
        col.add(Pages.card("Reply", stream));
        col.add(Ui.gap(12));

        // ---------------------------------------------------------------- proposal
        JPanel prop = Ui.column();
        col.add(prop);
        Runnable showProposal = () -> {
            prop.removeAll();
            if (last != null) {
                prop.add(proposalCard(app, last));
            }
            prop.revalidate();
            prop.repaint();
        };
        showProposal.run();

        run.addActionListener(e -> {
            String v = task.value();
            Assistant.Task tk = switch (v) {
                case "Fix" -> Assistant.Task.FIX;
                case "Write" -> Assistant.Task.WRITE;
                case "Explain" -> Assistant.Task.EXPLAIN;
                case "Python" -> Assistant.Task.PYTEST;
                case "Review" -> Assistant.Task.REVIEW;
                default -> Assistant.Task.VECTOR;
            };
            String n = note.getText();
            String why = kg.assist.Guard.checkNote(n);
            if (why != null) {
                app.toast(why, "BLOCKED");
                return;
            }
            Assistant.Request r = new Assistant.Request(tk, (String) file.getSelectedItem(), (String) req.getSelectedItem(), n);
            busy = true;
            last = null;
            lastStream = "";
            stream.setText("");
            showProposal.run();
            run.setEnabled(false);
            stop.setVisible(true);
            status.setText("Starting the engine...");
            Path project = app.data.project;
            Thread w = new Thread(() -> {
                String err = null;
                Assistant.Proposal p = null;
                try {
                    if (engine == null) {
                        engine = new EngineClient(app.home, st, new ModelStore(app.home).logFile());
                    }
                    running = new Assistant(app.home, project, engine);
                    p = running.run(r, new Assistant.Listener() {
                        @Override
                        public void status(String s) {
                            SwingUtilities.invokeLater(() -> status.setText(s));
                        }

                        @Override
                        public void token(String s) {
                            SwingUtilities.invokeLater(() -> {
                                stream.append(s);
                                lastStream = stream.getText();
                            });
                        }
                    });
                } catch (java.io.IOException | kg.core.InputException | RuntimeException ex) {
                    err = ex.getMessage();
                }
                Assistant.Proposal fp = p;
                String fe = err;
                SwingUtilities.invokeLater(() -> {
                    busy = false;
                    running = null;
                    last = fp;
                    run.setEnabled(true);
                    stop.setVisible(false);
                    status.setText(fe != null ? "" : "done");
                    if (fe != null) {
                        app.toast("Assistant: " + fe, "FAIL");
                    }
                    showProposal.run();
                });
            }, "kg-assistant");
            w.setDaemon(true);
            w.start();
        });
        stop.addActionListener(e -> {
            if (running != null) {
                running.cancel();
            }
        });
        return Pages.page("Assistant", "Local and offline. It proposes; Kindgleam's gates check; you decide. It has no say in any verdict.", col);
    }

    private static JComponent proposalCard(App app, Assistant.Proposal p) {
        Theme t = Ui.t;
        JPanel body = Ui.column();
        if (!p.explanation().isEmpty()) {
            body.add(Ui.left(Ui.textBlock(p.explanation(), false)));
            body.add(Ui.gap(8));
        }
        if (p.checked()) {
            JPanel sr = new JPanel(new BorderLayout(t.px(10), 0));
            sr.setOpaque(false);
            JPanel pill = new JPanel(new java.awt.GridBagLayout());
            pill.setOpaque(false);
            pill.add(Ui.status(p.checkPassed() ? "PASS" : "FAIL"));
            sr.add(pill, BorderLayout.WEST);
            sr.add(Ui.textBlock(p.checkSummary() + "  (" + p.attempts() + " attempt" + (p.attempts() == 1 ? "" : "s") + ")", false),
                    BorderLayout.CENTER);
            body.add(Ui.left(sr));
            body.add(Ui.gap(10));
        }
        if (p.hasChange()) {
            body.add(Ui.left(Ui.label(p.relPath(), 13f, Font.BOLD, t.text)));
            body.add(Ui.gap(4));
            body.add(Ui.left(diffView(p.before(), p.after())));
            body.add(Ui.gap(10));
            JPanel act = Ui.row(t.px(10));
            Ui.Btn apply = new Ui.Btn(p.checkPassed() ? "Apply" : "Apply anyway", p.checkPassed() ? Ui.Kind.PRIMARY : Ui.Kind.DANGER);
            Ui.Btn reject = new Ui.Btn("Reject", Ui.Kind.SECONDARY);
            apply.addActionListener(e -> {
                try {
                    new Assistant(app.home, app.data.project, engine).apply(p);
                    app.toast("Applied to " + p.relPath() + ". Run Verify for a verdict.", "OK");
                    last = null;
                    app.show("Assistant");
                } catch (java.io.IOException | kg.core.InputException ex) {
                    app.toast(ex.getMessage(), "FAIL");
                }
            });
            reject.addActionListener(e -> {
                try {
                    new Assistant(app.home, app.data.project, engine).reject(p);
                } catch (java.io.IOException | kg.core.InputException ex) {
                    // recording a rejection is best effort
                }
                last = null;
                app.show("Assistant");
            });
            act.add(apply);
            act.add(reject);
            act.add(Ui.muted("Transcript: " + app.data.project.relativize(p.transcript())));
            body.add(Ui.left(act));
        } else if (p.checked()) {
            body.add(Ui.left(Ui.muted("No change to apply.")));
        }
        return Pages.card("Proposal", body);
    }

    /** Line diff (longest common subsequence), coloured: removed red, added green. */
    static JComponent diffView(String a, String b) {
        Theme t = Ui.t;
        String[] x = a == null ? new String[0] : a.split("\n", -1);
        String[] y = b.split("\n", -1);
        JTextPane pane = new JTextPane();
        pane.setEditable(false);
        pane.setBackground(t.surface2);
        pane.setBorder(BorderFactory.createEmptyBorder(t.px(8), t.px(10), t.px(8), t.px(10)));
        StyledDocument doc = pane.getStyledDocument();
        SimpleAttributeSet same = style(t.muted, null);
        SimpleAttributeSet del = style(t.fail, t.failSoft);
        SimpleAttributeSet add = style(t.pass, t.passSoft);
        try {
            if ((long) x.length * y.length > 4_000_000L) {
                doc.insertString(0, "(file too large for a line diff; showing the new file)\n" + b, same);
            } else {
                int[][] l = new int[x.length + 1][y.length + 1];
                for (int i = x.length - 1; i >= 0; i--) {
                    for (int j = y.length - 1; j >= 0; j--) {
                        l[i][j] = x[i].equals(y[j]) ? l[i + 1][j + 1] + 1 : Math.max(l[i + 1][j], l[i][j + 1]);
                    }
                }
                int i = 0;
                int j = 0;
                int ctx = 0;
                while (i < x.length || j < y.length) {
                    if (i < x.length && j < y.length && x[i].equals(y[j])) {
                        boolean near = nearChange(x, y, l, i, j);
                        if (near) {
                            doc.insertString(doc.getLength(), "  " + x[i] + "\n", same);
                        } else if (ctx++ == 0) {
                            doc.insertString(doc.getLength(), "  ...\n", same);
                        }
                        i++;
                        j++;
                        continue;
                    }
                    ctx = 0;
                    if (j < y.length && (i == x.length || l[i][j + 1] >= l[i + 1][j])) {
                        doc.insertString(doc.getLength(), "+ " + y[j++] + "\n", add);
                    } else {
                        doc.insertString(doc.getLength(), "- " + x[i++] + "\n", del);
                    }
                }
            }
        } catch (javax.swing.text.BadLocationException e) {
            // not reachable: inserts are always at the end
        }
        return pane;
    }

    /** True when a change lies within three lines of this unchanged pair. */
    private static boolean nearChange(String[] x, String[] y, int[][] l, int i, int j) {
        for (int k = 1; k <= 3; k++) {
            int a = i - k;
            int b = j - k;
            if (a >= 0 && b >= 0 && !x[a].equals(y[b])) {
                return true;
            }
            a = i + k;
            b = j + k;
            if (a < x.length && b < y.length && !x[a].equals(y[b])) {
                return true;
            }
            if ((a >= x.length) != (b >= y.length)) {
                return true;
            }
        }
        return false;
    }

    private static SimpleAttributeSet style(Color fg, Color bg) {
        SimpleAttributeSet s = new SimpleAttributeSet();
        StyleConstants.setForeground(s, fg);
        if (bg != null) {
            StyleConstants.setBackground(s, bg);
        }
        StyleConstants.setFontFamily(s, Ui.t.mono.getFamily());
        StyleConstants.setFontSize(s, Math.round(12.5f * Ui.t.scale));
        return s;
    }
}
