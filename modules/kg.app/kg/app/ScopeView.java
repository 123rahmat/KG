package kg.app;

import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Font;
import java.awt.FontMetrics;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.Rectangle;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.awt.event.MouseWheelEvent;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import javax.swing.JComponent;
import javax.swing.Timer;
import kg.core.Trace;
import kg.core.Vector;

/**
 * Generic simulated oscilloscope. Lanes are grouped by unit; SIL is drawn solid and PIL dashed
 * on top; faults and the first SIL/PIL divergence are marked; the strip at the bottom shows the
 * whole run with the current view. Wheel = smooth zoom, drag = pan, double-click = whole run,
 * click a legend chip = show/hide. Displays evidence only; decides nothing.
 */
final class ScopeView extends JComponent {
    private static final long serialVersionUID = 1L;

    private transient Trace sil;
    private transient Trace pil;
    private transient Vector vector;
    private transient final Map<String, String> units = new LinkedHashMap<>();
    private transient final Set<String> hidden = new LinkedHashSet<>();
    private transient final List<Rectangle> chipRects = new ArrayList<>();
    private transient final List<String> chipNames = new ArrayList<>();
    private String title = "Select a run and a vector";
    private int diverge = -1;
    private double vs;
    private double ve = 1;
    private double ts;
    private double te = 1;
    private final Timer zoomTimer;
    private int mouseX = -1;
    private int dragX = -1;
    private double dragVs;
    private boolean draggingStrip;

    ScopeView() {
        setOpaque(true);
        zoomTimer = new Timer(16, e -> {
            vs += (ts - vs) * 0.25;
            ve += (te - ve) * 0.25;
            if (Math.abs(ts - vs) < 0.5 && Math.abs(te - ve) < 0.5) {
                vs = ts;
                ve = te;
                ((Timer) e.getSource()).stop();
            }
            repaint();
        });
        MouseAdapter m = new MouseAdapter() {
            @Override
            public void mouseWheelMoved(MouseWheelEvent e) {
                zoomAt(e.getX(), e.getWheelRotation() < 0 ? 0.75 : 1.33);
            }

            @Override
            public void mousePressed(MouseEvent e) {
                for (int i = 0; i < chipRects.size(); i++) {
                    if (chipRects.get(i).contains(e.getPoint())) {
                        String n = chipNames.get(i);
                        if (!hidden.remove(n)) {
                            hidden.add(n);
                        }
                        repaint();
                        return;
                    }
                }
                draggingStrip = e.getY() > getHeight() - stripH() - Ui.t.px(8);
                dragX = e.getX();
                dragVs = ts;
                if (draggingStrip) {
                    centerOnStrip(e.getX());
                }
            }

            @Override
            public void mouseDragged(MouseEvent e) {
                if (draggingStrip) {
                    centerOnStrip(e.getX());
                    return;
                }
                double span = te - ts;
                double nt = dragVs + (dragX - e.getX()) * span / Math.max(1, plotW());
                setView(nt, nt + span, false);
            }

            @Override
            public void mouseMoved(MouseEvent e) {
                mouseX = e.getX();
                repaint();
            }

            @Override
            public void mouseExited(MouseEvent e) {
                mouseX = -1;
                repaint();
            }

            @Override
            public void mouseClicked(MouseEvent e) {
                if (e.getClickCount() == 2) {
                    setView(0, ticks(), true);
                }
            }
        };
        addMouseListener(m);
        addMouseMotionListener(m);
        addMouseWheelListener(m);
    }

    void show(String title, Trace sil, Trace pil, Vector v, Map<String, String> unitsByName) {
        this.title = title;
        this.sil = sil;
        this.pil = pil;
        this.vector = v;
        units.clear();
        if (unitsByName != null) {
            units.putAll(unitsByName);
        }
        diverge = -1;
        if (sil != null && pil != null && sil.columns.equals(pil.columns) && sil.ticks() == pil.ticks()) {
            outer:
            for (int t = 0; t < sil.ticks(); t++) {
                for (int c = 0; c < sil.columns.size(); c++) {
                    if (sil.get(t, c) != pil.get(t, c)) {
                        diverge = t;
                        break outer;
                    }
                }
            }
        }
        vs = 0;
        ve = ticks();
        ts = vs;
        te = ve;
        repaint();
    }

    void focusFault() {
        if (vector != null && !vector.faults.isEmpty()) {
            int f = vector.firstFaultTick();
            setView(Math.max(0, f - 40), Math.min(ticks(), f + 160), true);
        } else if (vector != null && vector.sets.size() > 1) {
            int f = vector.sets.get(1).tick();
            setView(Math.max(0, f - 100), Math.min(ticks(), f + 600), true);
        }
    }

    private Trace base() {
        return sil != null ? sil : pil;
    }

    private int ticks() {
        return base() == null ? 1 : Math.max(1, base().ticks());
    }

    private int left() {
        return Ui.t.px(70);
    }

    private int plotW() {
        return getWidth() - left() - Ui.t.px(20);
    }

    private int stripH() {
        return Ui.t.px(34);
    }

    private void setView(double s, double e, boolean animate) {
        double span = Math.max(10, Math.min(ticks(), e - s));
        double ns = Math.max(0, Math.min(ticks() - span, s));
        ts = ns;
        te = ns + span;
        if (animate && !Ui.reduceMotion) {
            zoomTimer.start();
        } else {
            vs = ts;
            ve = te;
            repaint();
        }
    }

    private void zoomAt(int px, double f) {
        double at = ts + (px - left()) * (te - ts) / Math.max(1, plotW());
        double span = (te - ts) * f;
        setView(at - (at - ts) * f, at - (at - ts) * f + span, true);
    }

    private void centerOnStrip(int x) {
        double span = te - ts;
        double at = (x - left()) * (double) ticks() / Math.max(1, plotW());
        setView(at - span / 2, at + span / 2, false);
    }

    private double x(double tick) {
        return left() + (tick - vs) * plotW() / (ve - vs);
    }

    /** Lanes: one per unit among visible analog channels, then the watchdog lane. */
    private Map<String, List<Integer>> lanes() {
        Map<String, List<Integer>> m = new LinkedHashMap<>();
        Trace b = base();
        for (int c = 0; c < b.columns.size(); c++) {
            String n = b.columns.get(c);
            if (n.equals("wd") || hidden.contains(n)) {
                continue;
            }
            m.computeIfAbsent(units.getOrDefault(n, "-"), k -> new ArrayList<>()).add(c);
        }
        int wd = b.col("wd");
        if (wd >= 0 && !hidden.contains("wd")) {
            m.put("watchdog", List.of(wd));
        }
        return m;
    }

    @Override
    protected void paintComponent(Graphics g0) {
        Theme t = Ui.t;
        Graphics2D g = (Graphics2D) g0.create();
        Ui.hints(g);
        g.setColor(t.scopeBg);
        g.fillRect(0, 0, getWidth(), getHeight());
        g.setFont(t.size(13.5f, Font.BOLD));
        g.setColor(t.text);
        g.drawString(title, left(), t.px(24));
        if (base() == null) {
            g.setFont(t.size(13f, Font.PLAIN));
            g.setColor(t.muted);
            g.drawString("No trace for this run and vector yet. Run Verify, then pick it here.", left(), t.px(56));
            g.dispose();
            return;
        }
        chips(g);
        Map<String, List<Integer>> lanes = lanes();
        int top = t.px(68);
        int bottom = getHeight() - stripH() - t.px(40);
        int n = lanes.size();
        boolean hasWd = lanes.containsKey("watchdog");
        int wdH = hasWd ? t.px(36) : 0;
        int analog = n - (hasWd ? 1 : 0);
        int gapPx = t.px(10);
        int avail = bottom - top - wdH - gapPx * Math.max(0, n - 1);
        int laneH = analog == 0 ? 0 : avail / analog;
        int y = top;
        Color[] pal = t.series;
        for (Map.Entry<String, List<Integer>> e : lanes.entrySet()) {
            boolean wd = e.getKey().equals("watchdog");
            int h = wd ? wdH : laneH;
            double[] r = wd ? new double[] {0, 1} : range(e.getValue());
            lane(g, e.getKey(), y, h, r);
            for (int c : e.getValue()) {
                Color col = wd ? t.fail : pal[c % pal.length];
                if (sil != null) {
                    series(g, sil, c, y, h, r, col, false);
                }
                if (pil != null) {
                    series(g, pil, c, y, h, r, Theme.mix(col, t.dark ? Color.WHITE : Color.BLACK, 0.35f), true);
                }
            }
            y += h + gapPx;
        }
        markers(g, top, bottom);
        axis(g, bottom);
        strip(g);
        cursor(g, top, bottom);
        g.dispose();
    }

    private void chips(Graphics2D g) {
        Theme t = Ui.t;
        chipRects.clear();
        chipNames.clear();
        g.setFont(t.size(11.5f, Font.BOLD));
        FontMetrics fm = g.getFontMetrics();
        int x = left();
        int y = t.px(36);
        Trace b = base();
        for (int c = 0; c < b.columns.size(); c++) {
            String n = b.columns.get(c);
            String u = units.getOrDefault(n, "");
            String text = n + (u.isEmpty() || u.equals("-") ? "" : " " + u);
            int w = fm.stringWidth(text) + t.px(28);
            if (x + w > getWidth() - t.px(20)) {
                break;
            }
            boolean off = hidden.contains(n);
            Color col = n.equals("wd") ? t.fail : t.series[c % t.series.length];
            g.setColor(off ? t.surface2 : Theme.mix(t.scopeBg, col, 0.18f));
            g.fillRoundRect(x, y, w, t.px(22), t.px(22), t.px(22));
            g.setColor(off ? t.faint : col);
            g.fillOval(x + t.px(8), y + t.px(7), t.px(8), t.px(8));
            g.setColor(off ? t.faint : t.text);
            g.drawString(text, x + t.px(20), y + t.px(15));
            chipRects.add(new Rectangle(x, y, w, t.px(22)));
            chipNames.add(n);
            x += w + t.px(6);
        }
        String legend = pil != null ? "solid = SIL   dashed = PIL" : "SIL";
        g.setFont(t.size(11.5f, Font.PLAIN));
        g.setColor(t.muted);
        g.drawString(legend, getWidth() - t.px(20) - g.getFontMetrics().stringWidth(legend), t.px(24));
    }

    private double[] range(List<Integer> cols) {
        double lo = Double.MAX_VALUE;
        double hi = -Double.MAX_VALUE;
        for (Trace tr : new Trace[] {sil, pil}) {
            if (tr == null) {
                continue;
            }
            for (int c : cols) {
                for (int i = 0; i < tr.ticks(); i++) {
                    float v = tr.get(i, c);
                    lo = Math.min(lo, v);
                    hi = Math.max(hi, v);
                }
            }
        }
        if (hi - lo < 1e-6) {
            hi += 1;
            lo -= 1;
        }
        double pad = (hi - lo) * 0.08;
        return new double[] {lo - pad, hi + pad};
    }

    private void lane(Graphics2D g, String name, int y, int h, double[] r) {
        Theme t = Ui.t;
        g.setColor(t.scopeGrid);
        g.drawRoundRect(left(), y, plotW(), h, t.px(6), t.px(6));
        for (int k = 1; k < 4; k++) {
            int yy = y + h * k / 4;
            g.drawLine(left(), yy, left() + plotW(), yy);
        }
        g.setFont(t.size(11f, Font.PLAIN));
        g.setColor(t.muted);
        g.drawString(fmt(r[1]), t.px(8), y + t.px(12));
        g.drawString(fmt(r[0]), t.px(8), y + h);
        g.setFont(t.size(11.5f, Font.BOLD));
        g.setColor(t.faint);
        g.drawString(name, left() + t.px(8), y + t.px(15));
    }

    private static double map(double v, double lo, double hi, int y, int h) {
        return y + h - (v - lo) * h / (hi - lo);
    }

    /** Min/max per pixel column so long runs stay exact at any zoom. */
    private void series(Graphics2D g, Trace tr, int col, int y, int h, double[] r, Color c, boolean dashed) {
        g.setColor(c);
        g.setStroke(dashed ? new BasicStroke(1.4f, BasicStroke.CAP_BUTT, BasicStroke.JOIN_ROUND, 10f, new float[] {5f, 4f}, 0f)
                : new BasicStroke(pil != null ? 2.6f : 1.8f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
        int pw = plotW();
        int prev = Integer.MIN_VALUE;
        java.awt.geom.Path2D path = new java.awt.geom.Path2D.Float();
        for (int px = 0; px < pw; px++) {
            int a = (int) Math.floor(vs + (double) px * (ve - vs) / pw);
            int b = Math.max(a + 1, (int) Math.floor(vs + (double) (px + 1) * (ve - vs) / pw));
            if (a >= tr.ticks()) {
                break;
            }
            double mn = Double.MAX_VALUE;
            double mx = -Double.MAX_VALUE;
            for (int i = Math.max(0, a); i < Math.min(tr.ticks(), b); i++) {
                double v = tr.get(i, col);
                mn = Math.min(mn, v);
                mx = Math.max(mx, v);
            }
            int ya = (int) Math.round(map(mx, r[0], r[1], y, h));
            int yb = (int) Math.round(map(mn, r[0], r[1], y, h));
            int xx = left() + px;
            int mid = (ya + yb) / 2;
            if (prev == Integer.MIN_VALUE) {
                path.moveTo(xx, mid);
            } else {
                path.lineTo(xx, mid);
            }
            if (yb - ya > 1) {
                g.drawLine(xx, ya, xx, yb);
            }
            prev = mid;
        }
        g.draw(path);
        g.setStroke(new BasicStroke(1f));
    }

    private void markers(Graphics2D g, int top, int bottom) {
        Theme t = Ui.t;
        g.setFont(t.size(11f, Font.BOLD));
        if (vector != null) {
            for (Vector.Fault f : vector.faults) {
                mark(g, f.tick(), top, bottom, t.fail, f.kind().name().toLowerCase(Locale.ROOT) + " @" + f.tick());
            }
            for (Vector.Set s : vector.sets) {
                if (s.tick() > 0) {
                    mark(g, s.tick(), top, bottom, t.accent, "set @" + s.tick());
                }
            }
        }
        if (diverge >= 0) {
            double dx = x(diverge);
            if (dx >= left() && dx <= left() + plotW()) {
                g.setColor(t.fail);
                g.setStroke(new BasicStroke(2f));
                g.drawLine((int) dx, top, (int) dx, bottom);
                g.drawString("SIL and PIL differ from tick " + diverge, (int) dx + t.px(4), bottom - t.px(6));
                g.setStroke(new BasicStroke(1f));
            }
        }
    }

    private void mark(Graphics2D g, int tick, int top, int bottom, Color c, String label) {
        double fx = x(tick);
        if (fx < left() || fx > left() + plotW()) {
            return;
        }
        g.setColor(c);
        g.setStroke(new BasicStroke(1f, BasicStroke.CAP_BUTT, BasicStroke.JOIN_MITER, 10f, new float[] {4f, 4f}, 0f));
        g.drawLine((int) fx, top, (int) fx, bottom);
        g.setStroke(new BasicStroke(1f));
        g.drawString(label, (int) fx + Ui.t.px(4), top - Ui.t.px(4));
    }

    private void axis(Graphics2D g, int bottom) {
        Theme t = Ui.t;
        g.setFont(t.size(11f, Font.PLAIN));
        g.setColor(t.muted);
        double span = ve - vs;
        double step = nice(span / 8);
        for (double tk = Math.ceil(vs / step) * step; tk <= ve; tk += step) {
            int xx = (int) x(tk);
            g.drawLine(xx, bottom + t.px(2), xx, bottom + t.px(6));
            String s = Long.toString((long) tk);
            int sw = g.getFontMetrics().stringWidth(s);
            g.drawString(s, Math.max(t.px(2), Math.min(getWidth() - sw - t.px(4), xx - sw / 2)), bottom + t.px(20));
        }
        g.drawString("tick", t.px(8), bottom + t.px(20));
    }

    /** Whole-run overview with the visible window highlighted; click or drag to move. */
    private void strip(Graphics2D g) {
        Theme t = Ui.t;
        int y = getHeight() - stripH() - t.px(6);
        int h = stripH();
        g.setColor(t.surface2);
        g.fillRoundRect(left(), y, plotW(), h, t.px(8), t.px(8));
        Trace b = base();
        int col = -1;
        for (int c = 0; c < b.columns.size(); c++) {
            if (!b.columns.get(c).equals("wd") && !hidden.contains(b.columns.get(c))) {
                col = c;
                break;
            }
        }
        if (col >= 0) {
            double[] r = range(List.of(col));
            g.setColor(Theme.mix(t.surface2, t.series[col % t.series.length], 0.7f));
            int prev = -1;
            for (int px = 0; px < plotW(); px++) {
                int i = (int) ((long) px * b.ticks() / Math.max(1, plotW()));
                int yy = (int) map(b.get(Math.min(b.ticks() - 1, i), col), r[0], r[1], y + t.px(3), h - t.px(6));
                if (prev >= 0) {
                    g.drawLine(left() + px - 1, prev, left() + px, yy);
                }
                prev = yy;
            }
        }
        int x0 = left() + (int) (vs * plotW() / ticks());
        int x1 = left() + (int) (ve * plotW() / ticks());
        g.setColor(t.accentSoft);
        g.fillRoundRect(x0, y, Math.max(t.px(4), x1 - x0), h, t.px(6), t.px(6));
        g.setColor(t.accent);
        g.drawRoundRect(x0, y, Math.max(t.px(4), x1 - x0), h - 1, t.px(6), t.px(6));
    }

    private void cursor(Graphics2D g, int top, int bottom) {
        Theme t = Ui.t;
        if (mouseX < left() || mouseX > left() + plotW()) {
            return;
        }
        Trace b = base();
        int tick = (int) (vs + (mouseX - left()) * (ve - vs) / plotW());
        if (tick < 0 || tick >= b.ticks()) {
            return;
        }
        g.setColor(Theme.mix(t.scopeBg, t.text, 0.35f));
        g.drawLine(mouseX, top, mouseX, bottom);
        List<String> lines = new ArrayList<>();
        lines.add("tick " + tick);
        for (int c = 0; c < b.columns.size(); c++) {
            String n = b.columns.get(c);
            if (hidden.contains(n)) {
                continue;
            }
            String v = fmt(b.get(tick, c));
            if (pil != null && pil.ticks() > tick && pil.get(tick, c) != b.get(tick, c)) {
                v += "   PIL " + fmt(pil.get(tick, c));
            }
            lines.add(n + "  " + v);
        }
        g.setFont(t.size(11.5f, Font.PLAIN));
        FontMetrics fm = g.getFontMetrics();
        int w = 0;
        for (String s : lines) {
            w = Math.max(w, fm.stringWidth(s));
        }
        int bw = w + t.px(20);
        int bh = lines.size() * fm.getHeight() + t.px(12);
        int bx = mouseX + t.px(14);
        if (bx + bw > getWidth() - t.px(10)) {
            bx = mouseX - bw - t.px(14);
        }
        int by = top + t.px(8);
        g.setColor(new Color(t.surface.getRed(), t.surface.getGreen(), t.surface.getBlue(), 235));
        g.fillRoundRect(bx, by, bw, bh, t.px(10), t.px(10));
        g.setColor(t.border);
        g.drawRoundRect(bx, by, bw, bh, t.px(10), t.px(10));
        int yy = by + t.px(6) + fm.getAscent();
        for (int i = 0; i < lines.size(); i++) {
            g.setColor(i == 0 ? t.muted : t.text);
            g.drawString(lines.get(i), bx + t.px(10), yy);
            yy += fm.getHeight();
        }
    }

    private static double nice(double raw) {
        double p = Math.pow(10, Math.floor(Math.log10(Math.max(1, raw))));
        for (double m : new double[] {1, 2, 5, 10}) {
            if (m * p >= raw) {
                return m * p;
            }
        }
        return 10 * p;
    }

    private static String fmt(double v) {
        double a = Math.abs(v);
        if (a >= 1000) {
            return String.format(Locale.ROOT, "%.0f", v);
        }
        if (a >= 10) {
            return String.format(Locale.ROOT, "%.2f", v);
        }
        return String.format(Locale.ROOT, "%.3f", v);
    }
}
