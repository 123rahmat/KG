package kg.sil;

import java.lang.foreign.Arena;
import java.lang.foreign.FunctionDescriptor;
import java.lang.foreign.Linker;
import java.lang.foreign.MemorySegment;
import java.lang.foreign.SymbolLookup;
import java.lang.foreign.ValueLayout;
import java.lang.invoke.MethodHandle;
import java.nio.file.Path;
import kg.core.InputException;

/**
 * The engineer's C firmware, compiled for the PC and called through the Foreign Function and
 * Memory API. Loaded only inside a separate SIL or simulated-board process.
 *
 * Firmware ABI v2 (see examples and firmware-support/kg_fw_abi.h):
 *   uint32_t fw_abi_version(void);          returns 2
 *   uint32_t fw_n_in(void);  uint32_t fw_n_out(void);   must match interface.cfg
 *   uint32_t fw_state_size(void);
 *   void     fw_init(void *state);
 *   void     fw_step(void *state, const float *in, float *out);
 *   uint32_t fw_progress_token(const void *state, uint32_t tick);   low 3 bits = tasks completed
 */
public final class Firmware implements AutoCloseable {
    private static final int MAX_STATE_BYTES = 65536;

    private final Arena arena;
    private final MethodHandle init;
    private final MethodHandle step;
    private final MethodHandle token;
    private final MemorySegment state;
    private final MemorySegment in;
    private final MemorySegment out;
    public final int nIn;
    public final int nOut;

    public Firmware(Path library, int expectIn, int expectOut) throws Throwable {
        arena = Arena.ofConfined();
        try {
            Linker linker = Linker.nativeLinker();
            SymbolLookup lib = SymbolLookup.libraryLookup(library, arena);
            FunctionDescriptor u32 = FunctionDescriptor.of(ValueLayout.JAVA_INT);
            int abi = (int) linker.downcallHandle(find(lib, "fw_abi_version"), u32).invokeExact();
            if (abi != 2) {
                throw new InputException("firmware ABI version " + abi + "; this Kindgleam needs ABI 2 (fw_step with in[] and out[])");
            }
            nIn = (int) linker.downcallHandle(find(lib, "fw_n_in"), u32).invokeExact();
            nOut = (int) linker.downcallHandle(find(lib, "fw_n_out"), u32).invokeExact();
            if (nIn != expectIn || nOut != expectOut) {
                throw new InputException("firmware has " + nIn + " inputs and " + nOut + " outputs, but interface.cfg declares "
                        + expectIn + " and " + expectOut);
            }
            int bytes = (int) linker.downcallHandle(find(lib, "fw_state_size"), u32).invokeExact();
            if (bytes <= 0 || bytes > MAX_STATE_BYTES) {
                throw new InputException("fw_state_size returned " + bytes + " (allowed 1.." + MAX_STATE_BYTES + ")");
            }
            init = linker.downcallHandle(find(lib, "fw_init"), FunctionDescriptor.ofVoid(ValueLayout.ADDRESS));
            step = linker.downcallHandle(find(lib, "fw_step"),
                    FunctionDescriptor.ofVoid(ValueLayout.ADDRESS, ValueLayout.ADDRESS, ValueLayout.ADDRESS));
            token = linker.downcallHandle(find(lib, "fw_progress_token"),
                    FunctionDescriptor.of(ValueLayout.JAVA_INT, ValueLayout.ADDRESS, ValueLayout.JAVA_INT));
            state = arena.allocate(bytes, 16);
            in = arena.allocate(4L * Math.max(1, nIn), 16);
            out = arena.allocate(4L * Math.max(1, nOut), 16);
        } catch (Throwable t) {
            arena.close();
            throw t;
        }
    }

    private static MemorySegment find(SymbolLookup lib, String name) throws InputException {
        return lib.find(name).orElseThrow(() -> new InputException("firmware does not export " + name));
    }

    public void init() throws Throwable {
        state.fill((byte) 0);
        init.invokeExact(state);
    }

    /** One tick. Outputs are copied out; non-finite outputs are reported by the engine. */
    public float[] step(float[] inputs) throws Throwable {
        for (int i = 0; i < nIn; i++) {
            in.setAtIndex(ValueLayout.JAVA_FLOAT, i, inputs[i]);
        }
        step.invokeExact(state, in, out);
        float[] o = new float[nOut];
        for (int i = 0; i < nOut; i++) {
            o[i] = out.getAtIndex(ValueLayout.JAVA_FLOAT, i);
        }
        return o;
    }

    public int progressToken(int tick) throws Throwable {
        return (int) token.invokeExact(state, tick);
    }

    /** FNV-1a over the state bytes, so tiers and reruns can be compared exactly. */
    public int stateHash() {
        byte[] b = state.toArray(ValueLayout.JAVA_BYTE);
        int h = 0x811c9dc5;
        for (byte x : b) {
            h ^= (x & 0xff);
            h *= 0x01000193;
        }
        return h;
    }

    @Override
    public void close() {
        arena.close();
    }
}
