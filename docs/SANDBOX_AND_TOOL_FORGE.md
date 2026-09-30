# Tools that come from the situation

Kindgleam does not work from a fixed list of tools. For each step, it uses
the tools it has. When the situation needs data it does not have, it fetches
it from the web. When it needs a library, it installs it in its sandbox. When
it needs a tool that does not exist, it writes one, tests it, and keeps it
once an admin approves. The only outside services are the AI model and
Stripe.

## The toolbox (`src/toolbox.js`)

Answer, research and tool steps in chat can
call tools before answering. Each tool says whether it is ready. When it is
not, it says what it needs, and the AI tells the person that instead of
pretending.

| Tool | Does | Needs |
| --- | --- | --- |
| `file.read` | Reads attached PDF, Word, Excel, PowerPoint, CSV and text files, in parts | attached files |
| `data.analyze` | Describes a table column by column | an attached table |
| `web.search` | Searches the web through the AI provider's own search, with sources | the AI model |
| `web.fetch` | Reads a public page through the guarded fetcher | web access on |
| `web.download` | Downloads and reads a public PDF, spreadsheet, CSV or JSON (≤ 20 MB) | web access on |
| `math.evaluate` | Exact arithmetic through a parser | — |
| `code.run` | Runs Python or JavaScript in the sandbox, with libraries, on the attached files; can save outputs to Files | the sandbox |
| `tool.create` | Builds a new workspace tool (see below) | the sandbox |
| `schedule.create` | Sets a reminder, or a question asked in the chat at a set time | — |
| `schedule.list` | Lists the person's schedules | — |
| `memory.save` | Remembers something lasting the person said, for later chats | memory on |
| `memory.forget` | Forgets what the person asks it to forget | memory on |
| `ws.<name>` | A tool this workspace built and approved | the sandbox |

Tools with side effects (`tool.create`, `schedule.create`) are only **proposed**. They wait in
`run_actions` until a person approves them, and then run once, as that
person. A proposal can be decided only once. Answers show which tools were
used and the sources cited.

## The sandbox (`src/sandbox.js`, `bin/sandbox-runner.js`)

The sandbox is its own service on a host with a container runtime (Docker or
Podman; gVisor through `SANDBOX_RUNTIME=runsc` for stronger isolation).

```
RUNNER_TOKEN=<32+ chars> npm run sandbox-runner          # 127.0.0.1:8767
SANDBOX_RUNNER_URL=http://127.0.0.1:8767/v1/execute RUNNER_TOKEN=<same> npm start
```

Each job runs in throwaway containers, in two phases:

1. **Install** (only if packages are asked for): it may reach PyPI or npm.
   It installs **pre-built wheels only** (`pip --only-binary=:all:`) and runs
   **no npm scripts** (`--ignore-scripts`), so no package code runs while
   downloading. Package names are validated, so options can't be smuggled in.
2. **Run**: **no network**, a read-only system, all capabilities dropped,
   no privilege escalation, the unprivileged `nobody` user, and limits of
   1 CPU, 64–2048 MB of memory, 256 processes, 100 MB per file and at most
   2 minutes. Only `/work` is writable, and `out/` holds result files.

When the job includes tests, the tests run instead of the program, and a
failing test fails the step so the chat can fix the code. Networks that
inspect HTTPS need their certificate authority in `SANDBOX_CA_FILE`;
`SANDBOX_INSTALL_PROXY` sets a proxy for installs only.

### Languages

| Language | Image (`SANDBOX_IMAGE_*`) | Check before running | Tests |
| --- | --- | --- | --- |
| Python | `python:3.12-slim` (`_PYTHON`) | parse every changed file | `unittest`, or pytest for plain `test_` functions (installed for the run) |
| JavaScript | `node:22-slim` (`_NODE`) | `node --check` | `node:test` (`*.test.mjs`) |
| Go | `golang:1.23-alpine` (`_GO`) | `gofmt -e` | `go test -v ./...` (`*_test.go`); a `go.mod` is made if missing |
| Java | `eclipse-temurin:21-jdk-alpine` (`_JAVA`) | `javac` of every file | each `*Test.java` class is run; `ok`/`not ok` lines are counted |
| C, C++ | `gcc:14` (`_GCC`) | `-fsyntax-only` | each `test_*.c`/`.cpp` is built with the code (not `main.c`) and run |
| Rust | `rust:1-alpine` (`_RUST`) | `cargo check --offline` | `cargo test --offline` (`#[test]` in the code); a `Cargo.toml` is made if missing |

Only Python and JavaScript install packages from the web; the others use
their standard library.

`SANDBOX_LANGUAGES` (for example `python,javascript,java`) limits which
languages a sandbox runs; all seven by default. A language's image is fetched
the first time it is needed and kept (`SANDBOX_PULL_ON_DEMAND=false` turns
that off, so only images already installed are used). Code in a language the
sandbox cannot run is not left waiting: its test step is skipped with the
reason, the answer says it was not run and how to run it, and the check asks
a person to certify it. Go gets 90 seconds by default (it builds its standard
library in each sealed run), Rust 1 GB of memory.

### Projects

A code step can return a **project**: `files` (`[{ path, content }]`), an
optional `entry`, and `delete` (paths to remove). A project attached as a zip
is the base: files the step does not write stay as they are, deleted files
are left out, and every code file's tests run together. Only the files the
step wrote are syntax-checked, so an old file it did not touch is not its
problem. A fix returns only the files it changes and is laid over the
project. For a project larger than a step can read (60,000 characters by
default), the step is shown every file's path and the files that matter to
it in full: the ones its request and design steps name, their imports and
tests, and those whose definitions match its words.

The chat's code steps run in the sandbox (the `general-ai-sandbox` target)
when the person's own machine can't run them. The code step returns
`language`, `source`, `tests` and `packages`, or a project.

## The tool forge (`src/tool-forge.js`)

When no tool can do something the situation needs, and it will be needed
again, the AI calls `tool.create` with:
- a program that reads JSON on stdin and prints JSON;
- its tests;
- the libraries it needs.

1. The tests run in the sandbox. If they fail, the AI gets the output and
   fixes the tool. Nothing is proposed until they pass.
2. The passing tool is proposed, with its test result. Only a workspace
   **admin** can approve it.
3. Approval saves it to `workspace_tools` as `ws.<name>`. A new version
   replaces the old one. Settings → Workspace lists the tools, and admins can
   retire them.
4. Every later chat step in the workspace can use it.
   It runs in the sandbox, isolated like everything else.

## Schedules (`src/scheduling.js`)

Scheduling is built in; there is no outside calendar. A schedule is one of:

- a **reminder**, which creates a notification;
- an **ask**, which posts a question to the chat at that time, ready to open.

Rules are `once`, `daily`, `weekly` (chosen days), `monthly` (day 1–28) or
`interval` (at least 15 minutes). They follow the person's time zone,
including daylight-saving changes.

The scheduler runs next to the job worker. It claims due schedules in a short
transaction with a two-minute lease, so no two servers run the same one. It
then does each one under its owner's own access, re-checked each time; a
schedule whose owner lost access stops. The bell next to the name shows
notifications. Settings → Schedules lists the schedules, cancels them and
adds reminders directly.

## Memory across chats (`src/memory.js`)

What a person tells Kindgleam that stays true after the chat ends (their
work, place, equipment, projects, how they like answers) is kept as short
memories, one person in one workspace, under row-level security.

- The AI saves a memory with `memory.save` and removes one with
  `memory.forget` when asked; the answer shows "Saved to memory".
- Each later chat step gets up to 15 memories
  that matter for its goal: who the person is and how they like answers
  always, then the ones that share words with the goal.
- Only the chat's owner brings memories into it; another member working in
  a shared chat does not bring theirs, and never sees the owner's list.
- Passwords, keys, codes and card numbers are refused. The same fact said
  again refreshes the old memory; at most 300 are kept.
- Settings → Personalization → Memory lists, adds and deletes memories and
  turns memory off. When it is off, nothing is saved or recalled.
