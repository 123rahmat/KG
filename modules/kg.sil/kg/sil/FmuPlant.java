package kg.sil;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.lang.foreign.Arena;
import java.lang.foreign.FunctionDescriptor;
import java.lang.foreign.Linker;
import java.lang.foreign.MemorySegment;
import java.lang.foreign.SymbolLookup;
import java.lang.foreign.ValueLayout;
import java.lang.invoke.MethodHandle;
import java.lang.invoke.MethodHandles;
import java.lang.invoke.MethodType;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;
import kg.core.Hashing;
import kg.core.InputException;
import kg.core.SafeFiles;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

/**
 * FMI 2.0 Co-Simulation plant. The FMU (a zip) is unpacked with path and size checks, its
 * modelDescription.xml is parsed with external entities and DOCTYPEs refused, and its native
 * library is called through the Foreign Function and Memory API inside the SIL process only.
 */
final class FmuPlant extends Plant {
    private static final long MAX_UNZIPPED = 256L * 1024 * 1024;
    private static final int MAX_ENTRIES = 4000;

    private final Arena arena = Arena.ofConfined();
    private final MemorySegment comp;
    private final MethodHandle setReal;
    private final MethodHandle getReal;
    private final MethodHandle doStep;
    private final MethodHandle freeInstance;
    private final MemorySegment outVr;
    private final MemorySegment outVal;
    private final MemorySegment inVr;
    private final MemorySegment inVal;
    private final int nIn;
    private double time;

    FmuPlant(Spec s, Path projectDir, Path workDir) throws Exception {
        super(s);
        try {
            Path fmu = SafeFiles.inside(projectDir, s.fmu);
            Path dir = workDir.resolve("fmu-" + Hashing.sha256(fmu).substring(0, 16));
            if (!Files.isDirectory(dir)) {
                unzip(fmu, dir);
            }
            Document doc = parseXml(dir.resolve("modelDescription.xml"));
            Element root = doc.getDocumentElement();
            if (!"fmiModelDescription".equals(root.getTagName()) || !"2.0".equals(root.getAttribute("fmiVersion"))) {
                throw new InputException(s.fmu + ": not an FMI 2.0 model description");
            }
            String guid = root.getAttribute("guid");
            NodeList cs = root.getElementsByTagName("CoSimulation");
            if (cs.getLength() != 1) {
                throw new InputException(s.fmu + ": FMU does not support co-simulation");
            }
            String id = ((Element) cs.item(0)).getAttribute("modelIdentifier");
            if (!id.matches("[A-Za-z_][A-Za-z0-9_]{0,80}")) {
                throw new InputException(s.fmu + ": unsafe modelIdentifier");
            }
            Map<String, Long> realVars = new HashMap<>();
            NodeList vars = root.getElementsByTagName("ScalarVariable");
            for (int i = 0; i < vars.getLength(); i++) {
                Element v = (Element) vars.item(i);
                if (v.getElementsByTagName("Real").getLength() == 1) {
                    realVars.put(v.getAttribute("name"), Long.parseLong(v.getAttribute("valueReference")));
                }
            }
            Path lib = dir.resolve("binaries").resolve(platform()).resolve(System.mapLibraryName(id).replaceFirst("^lib", ""));
            if (!Files.isRegularFile(lib)) {
                lib = dir.resolve("binaries").resolve(platform()).resolve(System.mapLibraryName(id));
            }
            if (!Files.isRegularFile(lib)) {
                throw new InputException(s.fmu + ": no binary for " + platform() + " in the FMU");
            }

            Linker linker = Linker.nativeLinker();
            SymbolLookup fn = SymbolLookup.libraryLookup(lib, arena);
            SymbolLookup libc = linker.defaultLookup();
            MethodHandle instantiate = linker.downcallHandle(find(fn, "fmi2Instantiate"), FunctionDescriptor.of(
                    ValueLayout.ADDRESS, ValueLayout.ADDRESS, ValueLayout.JAVA_INT, ValueLayout.ADDRESS,
                    ValueLayout.ADDRESS, ValueLayout.ADDRESS, ValueLayout.JAVA_INT, ValueLayout.JAVA_INT));
            MethodHandle setup = linker.downcallHandle(find(fn, "fmi2SetupExperiment"), FunctionDescriptor.of(
                    ValueLayout.JAVA_INT, ValueLayout.ADDRESS, ValueLayout.JAVA_INT, ValueLayout.JAVA_DOUBLE,
                    ValueLayout.JAVA_DOUBLE, ValueLayout.JAVA_INT, ValueLayout.JAVA_DOUBLE));
            MethodHandle enter = linker.downcallHandle(find(fn, "fmi2EnterInitializationMode"),
                    FunctionDescriptor.of(ValueLayout.JAVA_INT, ValueLayout.ADDRESS));
            MethodHandle exit = linker.downcallHandle(find(fn, "fmi2ExitInitializationMode"),
                    FunctionDescriptor.of(ValueLayout.JAVA_INT, ValueLayout.ADDRESS));
            FunctionDescriptor rw = FunctionDescriptor.of(ValueLayout.JAVA_INT, ValueLayout.ADDRESS, ValueLayout.ADDRESS,
                    ValueLayout.JAVA_LONG, ValueLayout.ADDRESS);
            setReal = linker.downcallHandle(find(fn, "fmi2SetReal"), rw);
            getReal = linker.downcallHandle(find(fn, "fmi2GetReal"), rw);
            doStep = linker.downcallHandle(find(fn, "fmi2DoStep"), FunctionDescriptor.of(ValueLayout.JAVA_INT,
                    ValueLayout.ADDRESS, ValueLayout.JAVA_DOUBLE, ValueLayout.JAVA_DOUBLE, ValueLayout.JAVA_INT));
            freeInstance = linker.downcallHandle(find(fn, "fmi2FreeInstance"), FunctionDescriptor.ofVoid(ValueLayout.ADDRESS));

            MethodHandle logger = MethodHandles.lookup().findStatic(FmuPlant.class, "log", MethodType.methodType(void.class,
                    MemorySegment.class, MemorySegment.class, int.class, MemorySegment.class, MemorySegment.class));
            MemorySegment loggerStub = linker.upcallStub(logger, FunctionDescriptor.ofVoid(ValueLayout.ADDRESS,
                    ValueLayout.ADDRESS, ValueLayout.JAVA_INT, ValueLayout.ADDRESS, ValueLayout.ADDRESS), arena);
            MemorySegment callbacks = arena.allocate(5 * ValueLayout.ADDRESS.byteSize(), 8);
            callbacks.setAtIndex(ValueLayout.ADDRESS, 0, loggerStub);
            callbacks.setAtIndex(ValueLayout.ADDRESS, 1, find(libc, "calloc"));
            callbacks.setAtIndex(ValueLayout.ADDRESS, 2, find(libc, "free"));
            callbacks.setAtIndex(ValueLayout.ADDRESS, 3, MemorySegment.NULL);
            callbacks.setAtIndex(ValueLayout.ADDRESS, 4, MemorySegment.NULL);

            String res = dir.resolve("resources").toAbsolutePath().toString().replace(File.separatorChar, '/');
            String uri = res.startsWith("/") ? "file://" + res : "file:///" + res;
            comp = (MemorySegment) instantiate.invokeExact(cstr("kindgleam"), 1,
                    cstr(guid), cstr(uri), callbacks, 0, 0);
            if (comp.equals(MemorySegment.NULL)) {
                throw new InputException(s.fmu + ": fmi2Instantiate failed");
            }
            check((int) setup.invokeExact(comp, 0, 0.0, 0.0, 0, 0.0), "fmi2SetupExperiment");
            check((int) enter.invokeExact(comp), "fmi2EnterInitializationMode");
            check((int) exit.invokeExact(comp), "fmi2ExitInitializationMode");

            outVr = arena.allocate(4L * s.outputs.size(), 4);
            outVal = arena.allocate(8L * s.outputs.size(), 8);
            for (int i = 0; i < s.outputs.size(); i++) {
                outVr.setAtIndex(ValueLayout.JAVA_INT, i, (int) vr(realVars, s.outputs.get(i).var(), s.fmu));
            }
            nIn = s.drives.size() + (s.disturbVar != null ? 1 : 0);
            inVr = arena.allocate(4L * nIn, 4);
            inVal = arena.allocate(8L * nIn, 8);
            for (int i = 0; i < s.drives.size(); i++) {
                inVr.setAtIndex(ValueLayout.JAVA_INT, i, (int) vr(realVars, s.drives.get(i).var(), s.fmu));
            }
            if (s.disturbVar != null) {
                inVr.setAtIndex(ValueLayout.JAVA_INT, nIn - 1, (int) vr(realVars, s.disturbVar, s.fmu));
            }
            readOutputs();
        } catch (Exception | Error e) {
            arena.close();
            throw e;
        } catch (Throwable t) {
            arena.close();
            throw new IllegalStateException("FMU setup failed: " + t, t);
        }
    }

    /** NUL-terminated UTF-8 string; written by hand so the code is the same on Java 21 and 22+. */
    private MemorySegment cstr(String s) {
        byte[] b = s.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        MemorySegment m = arena.allocate(b.length + 1L, 1);
        MemorySegment.copy(b, 0, m, ValueLayout.JAVA_BYTE, 0, b.length);
        m.set(ValueLayout.JAVA_BYTE, b.length, (byte) 0);
        return m;
    }

    @SuppressWarnings("unused")
    private static void log(MemorySegment env, MemorySegment inst, int status, MemorySegment cat, MemorySegment msg) {
        /* FMU log messages are ignored; status codes are checked on every call instead. */
    }

    private static MemorySegment find(SymbolLookup l, String n) throws InputException {
        return l.find(n).orElseThrow(() -> new InputException("FMU binary does not export " + n));
    }

    private static long vr(Map<String, Long> vars, String name, String fmu) throws InputException {
        Long v = vars.get(name);
        if (v == null) {
            throw new InputException(fmu + ": no Real variable named " + name);
        }
        return v;
    }

    private static void check(int status, String what) throws InputException {
        if (status > 1) { /* 0 OK, 1 Warning; Discard, Error, Fatal, Pending are failures */
            throw new InputException("FMU " + what + " returned status " + status);
        }
    }

    static String platform() {
        String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
        String p = os.startsWith("windows") ? "win64" : os.contains("mac") ? "darwin64" : "linux64";
        return p;
    }

    private void readOutputs() throws Throwable {
        check((int) getReal.invokeExact(comp, outVr, (long) y.length, outVal), "fmi2GetReal");
        for (int i = 0; i < y.length; i++) {
            double v = outVal.getAtIndex(ValueLayout.JAVA_DOUBLE, i);
            if (!Double.isFinite(v)) {
                throw new InputException("FMU produced a non-finite output");
            }
            y[i] = (float) v;
        }
    }

    @Override
    public void step(float[] fwOut, float d, float dt) throws Exception {
        try {
            for (int i = 0; i < spec.drives.size(); i++) {
                Drive dr = spec.drives.get(i);
                inVal.setAtIndex(ValueLayout.JAVA_DOUBLE, i, (double) dr.gain() * fwOut[dr.fwOutput()]);
            }
            if (spec.disturbVar != null) {
                inVal.setAtIndex(ValueLayout.JAVA_DOUBLE, nIn - 1, d);
            }
            check((int) setReal.invokeExact(comp, inVr, (long) nIn, inVal), "fmi2SetReal");
            check((int) doStep.invokeExact(comp, time, (double) dt, 1), "fmi2DoStep");
            time += dt;
            readOutputs();
        } catch (Exception e) {
            throw e;
        } catch (Throwable t) {
            throw new IllegalStateException("FMU call failed: " + t, t);
        }
    }

    @Override
    public void close() {
        try {
            freeInstance.invokeExact(comp);
        } catch (Throwable t) {
            // closing anyway
        }
        arena.close();
    }

    private static Document parseXml(Path p) throws Exception {
        DocumentBuilderFactory f = DocumentBuilderFactory.newInstance();
        f.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        f.setFeature("http://xml.org/sax/features/external-general-entities", false);
        f.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
        f.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
        f.setXIncludeAware(false);
        f.setExpandEntityReferences(false);
        f.setNamespaceAware(false);
        DocumentBuilder b = f.newDocumentBuilder();
        if (Files.size(p) > 16L * 1024 * 1024) {
            throw new InputException("modelDescription.xml too large");
        }
        try (InputStream in = Files.newInputStream(p)) {
            return b.parse(in);
        }
    }

    /** Unpacks into dir; refuses absolute paths, "..", too many entries or too many bytes. */
    static void unzip(Path fmu, Path dir) throws IOException, InputException {
        Path tmp = Files.createTempDirectory(dir.getParent(), ".unzip-");
        long total = 0;
        int count = 0;
        try (ZipFile z = new ZipFile(fmu.toFile())) {
            Enumeration<? extends ZipEntry> en = z.entries();
            while (en.hasMoreElements()) {
                ZipEntry e = en.nextElement();
                if (++count > MAX_ENTRIES) {
                    throw new InputException("FMU has too many files");
                }
                String n = e.getName().replace('\\', '/');
                if (n.startsWith("/") || n.contains("../") || n.equals("..") || n.contains(":")) {
                    throw new InputException("FMU contains an unsafe path: " + n);
                }
                Path out = tmp.resolve(n).normalize();
                if (!out.startsWith(tmp)) {
                    throw new InputException("FMU path escapes its folder: " + n);
                }
                if (e.isDirectory()) {
                    Files.createDirectories(out);
                    continue;
                }
                Files.createDirectories(out.getParent());
                try (InputStream in = z.getInputStream(e)) {
                    byte[] buf = new byte[65536];
                    try (var os = Files.newOutputStream(out)) {
                        int r;
                        while ((r = in.read(buf)) > 0) {
                            total += r;
                            if (total > MAX_UNZIPPED) {
                                throw new InputException("FMU unpacks to more than 256 MB");
                            }
                            os.write(buf, 0, r);
                        }
                    }
                }
            }
        }
        Files.move(tmp, dir, StandardCopyOption.ATOMIC_MOVE);
    }
}
