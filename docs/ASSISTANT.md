# The coding assistant

An optional helper for writing and fixing firmware. It is off by default, runs only on this computer,
and has no authority: it proposes, Kindgleam's gates check, and a person decides.

## Parts

| Part | What it is |
| --- | --- |
| Model | Qwen2.5-Coder-1.5B-Instruct, Q4_K_M GGUF, 1.1 GB, Apache-2.0 (recommended), or the official Q8_0 file (1.9 GB, about 2.5 GB RAM, slower). One file, used byte-for-byte as published. `model/MODEL.txt` pins both SHA-256 fingerprints; anything else is refused. |
| Engine | `engine/src`, about 1,500 lines of standard C++17 written for Kindgleam. CPU only, multi-threaded, AVX2 kernels chosen at run time. Reads only the model file and its own stdin. |
| Client | `kg.assist`: seals the model, starts the engine, keeps it to fixed tasks, runs the write-check-fix loop. |
| App | The assistant panel beside the editor on the **Code** page, and two switches in Settings (assistant on/off, review every run automatically). |

## Installing the model (once)

1. On any computer with internet, download the file named in `model/MODEL.txt` (`SOURCE` line).
2. `kindgleam model install <file>` reads the whole file and compares its SHA-256 with the pinned value. Any
   other file is refused and nothing is installed. The accepted file is copied into `model/` unchanged, and
   `model/model.seal` records its name, size and hash, signed with this computer's key.
3. In a package that already contains the model, the app offers **Check and seal the model** instead.

## Safety at every step

**Loading.** The app checks the seal signature and the file size. The engine then hashes the exact bytes it
reads into memory and refuses to start if they differ from the sealed hash, so a file swapped after the check
is still caught. The file is parsed as untrusted input: every count, length, offset, shape and type is bounded,
tensors may not overlap or leave the file, and anything unexpected stops loading. 300 randomly corrupted model
files were all rejected or loaded safely under AddressSanitizer, with no crash.

**Running.** The engine contains no network code; the build fails if the binary imports any socket, process or
code-loading function (`nm` on Linux/macOS, an import scan on Windows). On Linux it also runs inside the same
no-network namespace as every other Kindgleam job. It opens no files after loading, runs no commands, and
handles each request from an empty context with token and time limits. Stopping a request kills the process.

**Reading the results.** After SIL, PIL or HIL the assistant gets a digest that fixed code builds from the run
folder (`kg.assist.RunDigest`): the gate results and why the run stopped; for every requirement how close it came
to failing (its margin, computed by `kg.gates.Margins` from the recorded traces) and at which tick; the signal values
around any failure; checks whose "whenever" part never happened in a test; SIL/PIL agreement, link and timing
figures; lines no test runs; planted bugs no test caught, with the source line; and stack frames near the limit.
The review then suggests improvements to the code (as `file:line` suggestions placed on those lines) and, where the
digest shows a need, to tests, requirements, the plant model, limits, timing on the real chip or the HIL set-up.
The same margins table is shown to everyone on each run's page, with or without the assistant.

**Asking.** There is no open chat. The jobs are fixed: fix this file or one marked line, write or change
code from a short description (in the open file or a new one), write a test vector, explain a file, and review
the last run. Explain and Review only produce text; the others produce a proposal. The only free text is an optional note of up to 1,500 characters, checked by
fixed rules that refuse requests about malware, exploits, getting around licensing or security, disabling
safety functions, weapons and covert surveillance. Text the user types can never become a control token in the
conversation, so it cannot rewrite the assistant's instructions.

**Answering.** The model is given the project's interface, headers, requirement and (when present)
`registers.cfg`, and told to mark anything not given as unknown rather than invent it. Replies use greedy
decoding, so the same request gives the same answer. Every reply is scanned for forbidden constructs (network,
processes, file deletion, code loading) before anything else happens.

**Checking.** Code goes into a scratch copy of the project and through Kindgleam's own gates G0-G4 (spec,
source policy, strict build, symbols, stack). A Python generator also goes through G17 there: it runs twice in
the sandbox, must print identical output, and every vector it prints must be valid. Failures, including
compiler errors and non-repeatable output, go back to the model, up to three attempts. Replies are also scanned
for forbidden Python (processes, file writing, low-level or dynamic imports). Test vectors must parse against
the interface and plant.

**Deciding.** You see a diff with the check result. Nothing is written to the project until you press Apply; a
proposal that did not pass says "Apply anyway" in red. Apply refuses if the file changed meanwhile. Apply and
Reject are recorded in project memory. The full conversation and every check are kept in
`jobs/assist-NNNN/transcript.txt`. A verdict still needs a normal Verify run.

## Limits, stated plainly

- No model is free of mistakes. The loop makes made-up code rare and visible, not impossible.
- The topic rules are a fixed word list, not understanding. They stop casual misuse inside Kindgleam; someone who
  copies the model file into another program is not bound by them. `docs/ACCEPTABLE_USE.md` is shown and must be
  accepted when the assistant is turned on.
- A 1.5B model is good at functions, state machines and fixing gate failures in files of a few hundred lines.
  Larger designs need a person.
- Speed, measured on a 2-core 2.8 GHz cloud machine with a model of exactly the real size and formats
  (1.5 B parameters, random weights): about 6.5 tokens per second while answering and 16 tokens per second
  while reading the prompt; 1.5 GB of memory with an 8,192-token context. A typical request
  (1,500-2,500 prompt tokens, a few hundred answer tokens) therefore takes about 2-4 minutes on such a
  machine. Speed grows with CPU cores; a 4-8 core laptop should be roughly 2-4 times faster, but that
  has not been measured here. CPUs with AVX2 (almost all x86-64 since 2015) use the fast kernels; others,
  and ARM, use portable kernels that give the same results more slowly.
