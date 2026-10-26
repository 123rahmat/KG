import java.awt.*;
import java.awt.geom.*;
import java.awt.image.BufferedImage;
import java.io.*;
import java.nio.file.*;
import javax.imageio.ImageIO;

/** Draws the Kindgleam icon and writes PNG (Linux), ICO (Windows) and ICNS (macOS) versions. */
public class MakeIcons {
    static BufferedImage draw(int s) {
        BufferedImage im = new BufferedImage(s, s, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = im.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
        float m = s * 0.06f;
        g.setPaint(new GradientPaint(0, 0, new Color(0x2BB5A0), s, s, new Color(0x1E5FA8)));
        g.fill(new RoundRectangle2D.Float(m, m, s - 2 * m, s - 2 * m, s * 0.42f, s * 0.42f));
        // a signal trace that settles and ends in a check mark: signals, verified
        g.setColor(new Color(255, 255, 255, 60));
        g.setStroke(new BasicStroke(s * 0.012f));
        for (int k = 1; k <= 3; k++) {
            float y = m + (s - 2 * m) * k / 4f;
            g.draw(new Line2D.Float(m * 2.2f, y, s - m * 2.2f, y));
        }
        Path2D t = new Path2D.Float();
        float x0 = s * 0.18f, mid = s * 0.52f;
        t.moveTo(x0, mid);
        t.curveTo(s * 0.24f, s * 0.20f, s * 0.30f, s * 0.20f, s * 0.34f, mid);
        t.curveTo(s * 0.37f, s * 0.70f, s * 0.41f, s * 0.68f, s * 0.44f, s * 0.56f);
        t.lineTo(s * 0.52f, s * 0.70f);
        t.lineTo(s * 0.80f, s * 0.30f);
        g.setColor(Color.WHITE);
        g.setStroke(new BasicStroke(s * 0.075f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
        g.draw(t);
        g.dispose();
        return im;
    }

    static byte[] png(BufferedImage im) throws IOException {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        ImageIO.write(im, "png", o);
        return o.toByteArray();
    }

    static void le16(OutputStream o, int v) throws IOException { o.write(v & 255); o.write((v >> 8) & 255); }
    static void le32(OutputStream o, int v) throws IOException { le16(o, v & 0xFFFF); le16(o, v >>> 16); }
    static void be32(OutputStream o, int v) throws IOException { o.write(v >>> 24); o.write((v >> 16) & 255); o.write((v >> 8) & 255); o.write(v & 255); }

    public static void main(String[] a) throws IOException {
        Path out = Path.of(a[0]);
        Files.createDirectories(out);
        Files.write(out.resolve("kindgleam.png"), png(draw(512)));
        // ICO: several PNG-compressed sizes (supported since Windows Vista)
        int[] sizes = {16, 24, 32, 48, 64, 128, 256};
        byte[][] imgs = new byte[sizes.length][];
        for (int i = 0; i < sizes.length; i++) imgs[i] = png(draw(sizes[i]));
        try (OutputStream o = new BufferedOutputStream(Files.newOutputStream(out.resolve("kindgleam.ico")))) {
            le16(o, 0); le16(o, 1); le16(o, sizes.length);
            int offset = 6 + 16 * sizes.length;
            for (int i = 0; i < sizes.length; i++) {
                o.write(sizes[i] >= 256 ? 0 : sizes[i]); o.write(sizes[i] >= 256 ? 0 : sizes[i]);
                o.write(0); o.write(0); le16(o, 1); le16(o, 32); le32(o, imgs[i].length); le32(o, offset);
                offset += imgs[i].length;
            }
            for (byte[] b : imgs) o.write(b);
        }
        // ICNS: PNG chunks ic07 (128), ic08 (256), ic09 (512), ic10 (1024)
        String[] types = {"ic07", "ic08", "ic09", "ic10"};
        int[] px = {128, 256, 512, 1024};
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        for (int i = 0; i < types.length; i++) {
            byte[] b = png(draw(px[i]));
            body.write(types[i].getBytes("US-ASCII")); be32(body, b.length + 8); body.write(b);
        }
        try (OutputStream o = Files.newOutputStream(out.resolve("kindgleam.icns"))) {
            o.write("icns".getBytes("US-ASCII")); be32(o, body.size() + 8); body.writeTo(o);
        }
        System.out.println("icons written to " + out);
    }
}
