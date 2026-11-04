# pi-code

The [pi](https://pi.dev) coding agent as an occasional local-model stand-in
for Claude Code: pi on the arbiter's default model, inside a bubblewrap
sandbox, with a bash classifier we own, an advisor for second opinions, web
search, and per-project memory that stays private to the local model.

```
pi-code/
├── PI_VERSION                 pinned pi release (install.sh installs exactly this)
├── pi.sh                      `pi` on PATH: builds the sandbox, then runs pi in it
├── extensions/                → ~/.pi/agent/extensions/homelab (auto-loaded)
│   ├── index.ts               entry point; wires the modules below
│   ├── secrets.ts             reads the keys pi.sh hands over on fd 3
│   ├── arbiter.ts             arbiter client: Bearer auth, retry/backoff past its 600 s wait
│   ├── arbiter-provider.ts    provider "arbiter", model "default"
│   ├── classifier-core.ts     classifier decision logic (shared with the eval)
│   ├── bash-classifier.ts     tool_call hook: gates bash, fails closed
│   ├── advisor.ts             ask_advisor tool + /advisor command
│   ├── web-search.ts          web_search (Brave) + web_fetch tools
│   ├── memory-core.ts         project memory: storage, index, recall, write checks
│   └── memory.ts              remember/forget tools, recall hook, /memories
├── policy/
│   ├── bash-safety-sandbox.md classifier policy inside the sandbox (default)
│   ├── bash-safety.md         classifier policy without it (PI_NOSANDBOX=1)
│   └── claude-code-full.md    captured Claude Code auto-mode policy (optional)
└── eval/                      labeled cases + fixtures + runner
```

## Install

On the VMs this is automatic. The Ansible `vm_base` role installs `nodejs`,
`npm` and `bubblewrap` from apt where `pi_agent: true`, and the dotfiles
installer (re-run by the 30-minute update timer whenever the repo changes):

- installs pi at the version in `PI_VERSION` into
  `~/.local/share/pi-agent/<version>` (no sudo, `--ignore-scripts`), and
  removes any other version — bumping `PI_VERSION` upgrades every VM;
- links `~/.local/bin/pi` → `pi.sh` and `~/.pi/agent/extensions/homelab` →
  `extensions/`;
- sets `defaultProvider: arbiter`, `defaultModel: default`, and
  `httpIdleTimeoutMs ≥ 900000` in `~/.pi/agent/settings.json` (pi's default
  300 s abandons requests the arbiter would still serve).

Keys go in `~/.dotfiles/.env` (or `~/.config/pi-agent/env`):

```bash
PI_ARBITER_KEY=arb_...      # falls back to OPENCODE_ARBITER_KEY
BRAVE_API_KEY=...           # optional; enables web_search
```

## Use

```bash
cd ~/some-project
pi                          # interactive
pi -p "why does the build fail?"
PI_LOCAL_READONLY=1 pi      # plan mode: edits and non-read-only bash blocked
PI_RW=/mnt/raid/Foundry pi  # extra writable paths (colon-separated)
PI_NOSANDBOX=1 pi           # no sandbox: loud warning, stricter host policy
```

`/advisor [model=<name>] <question>` asks the advisor yourself; the answer
lands in the conversation so the agent sees it too.

## The sandbox (`pi.sh`)

Whole-process bubblewrap: pi, its tools, every bash command, and the
extensions all run inside. The kernel enforces it; the model is never asked.

| | Inside the sandbox |
|---|---|
| Project (git toplevel of `$PWD`, else `$PWD`) | read-write, except `.git/hooks`, `.git/config`, this launcher, and any file home links into the project (read-only: they run outside the sandbox later) |
| Started in `$HOME`, above it (incl. `/`), or under `/mnt` | read-only session — nothing is made writable |
| `/tmp`, `/var/tmp` | private, empty, discarded at exit |
| Tool caches (`~/.cache`, `~/.npm`, `~/.cargo`, `~/.rustup`, `uv`, `pnpm`, `~/go`) | writable but throwaway (tmpfs overlay): `~/.cargo/bin`, `~/.cargo/env` and pre-commit envs run outside later |
| Rest of home, `/etc`, `/usr`, … | read-only |
| `/mnt/raid` (all of tank the VM mounts) | read-only; `PI_RW=<path>` to opt in |
| `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.docker`, `~/.kube`, gh/op/gcloud, Claude/Codex/Gemini/opencode credentials, `.env`, shell histories | hidden (empty) |
| `~/.claude/projects` (Claude Code chat transcripts) | read-only; the rest of `~/.claude` stays hidden |
| SSH agent, `/run/user/<uid>` sockets | unreachable |
| Environment | rebuilt from an allowlist; no keys |
| Keys | on fd 3 to pi only; `secrets.ts` closes it before any tool runs |
| `~/.pi/agent` | throwaway overlay; only `sessions/` persists; `auth.json` reads as `{}` |
| sudo / setuid | no privilege gain |
| Processes | own PID namespace |
| **Docker** | **full access** (root daemon — the classifier's job) |
| **Network** | **shared with the host** (internet and LAN) |

Why the agent dir is an overlay: anything written there — settings, trust,
an extension, a system prompt — would load into the next pi process, where it
could switch the classifier off. So in-session writes go to a tmpfs that is
discarded. The cost: `/settings`, `/trust` and `/login` changes made inside
pi don't persist; make those with `PI_NOSANDBOX=1 pi` or edit the files.

pi warns at exit if the project's `.git` was changed or replaced during the
session — the read-only mounts can't stop the agent swapping `.git` wholesale.

Starting pi in `$HOME` (or above it) gives a read-only session: you can look
around and ask questions, but nothing in home is writable — a writable home
would let the agent edit `~/.bashrc`, `~/.profile` or user systemd units, which
run outside the sandbox at your next login. To start a new project, `mkdir`
it and run `pi` inside. In `~/dotfiles` the agent can edit
ordinary files, but not the launcher or anything home links to (`bashrc`,
`~/.local/bin/*`, the Claude guard hook); the classifier source still shows up
in `git diff` if it changes.

**Docker is the hole, on purpose.** The VMs run their services in root
Docker and the agent needs real docker access, so the socket stays reachable
and a container can undo everything above. The classifier is what judges
docker: host mounts outside the project, `--privileged`, host namespaces,
devices, the docker socket, and destroying other services' data are BLOCK —
in a `docker run` line and in compose files, which it reads. Locking docker
down (rootless, or a filtering socket proxy) is a later project.

## The classifier

`bash-classifier.ts` runs on every `tool_call` for `bash`:

1. **Fast path.** A single read-only command (`ls`, `cat`, `grep`, …) with no
   shell metacharacters, no `$`, and no sensitive path dispatches without a
   model call.
2. **Read what actually runs.** The resident model once found the hole in a
   text-only classifier: write a payload to a file, run it with a boring
   `python3 ~/x/script.py`. So any local file that decides what a command
   executes is read at execution time and judged with it:
   - scripts run by an interpreter (`python3 x.py`, `bash x.sh`, `node x.js`,
     `python3 -m pkg.mod` for a project module), `source`, `./x`, stdin
     redirects (`python3 < x.py`), through `env`/`nice`/`sudo`/`timeout`
     and `uv`/`poetry`/`pipenv run` wrappers;
   - compose files for `docker compose up/run/create/start/restart`
     (`-f`, `--project-directory`, overrides);
   - Makefiles for `make` (`-f`, `-C`), justfiles for `just`;
   - package.json `scripts` for `npm`/`yarn`/`pnpm`/`bun run`.
   Wrapper flags with values (`sudo -u x`, `timeout -s KILL 30`) and
   interpreter flags with values (`python3 -W ignore x.py`, `node -r ./pre.js`)
   don't hide the script; arguments after the script are data, not code.
   A file it finds but can't fully vet — unreadable, over 64 KB, or more than
   4 — blocks. Code it can't see at all (`cat f | python3`, `bash -c
   "$(...)"`, `curl | sh`) is a named BLOCK in the policy.
3. **One verdict** from the arbiter's default model, thinking off,
   `VERDICT: ALLOW/BLOCK`. The command is fenced between random-nonce markers
   so text inside it can't pose as prompt structure. Unparseable → BLOCK.

The two policies differ in what they spend the model on. **Sandbox**
(default): only what the sandbox can't stop — docker escapes, code it can't
see, data leaving the machine, publishing, changes to LAN infrastructure,
broad deletes — and explicitly ALLOW anything whose only harm the sandbox
already prevents (reading another project, `pip install --user`, writes that
would hit a read-only path). **Host** (`PI_NOSANDBOX=1`): the model is the
only guard, so it also blocks secret reads, persistence, system changes and
writes outside the working tree.

The classifier always asks for `model: "default"`. After an advisor swap the
arbiter holds that request until the default is back, so verdicts retry the
contract's retryable codes (503 `model_swapping`, 408, 504, …) with backoff
for up to 660 s — past the arbiter's 600 s budget — showing "classifier
waiting for arbiter" in the footer, and fail closed after that. An arbiter that
can't be reached at all (network down) fails closed after a minute instead.
`PI_CLASSIFIER_DEADLINE_MS` overrides it.

`PI_LOCAL_POLICY=<file>` swaps the policy (e.g. `policy/claude-code-full.md`,
which emits `<block>yes/no</block>` and is auto-detected). The full policy is
~28K tokens a verdict and was written for Claude Code's transcript, so it runs
more conservative here.

Threat model: an agent going off the rails on its own (bad plan, prompt
injection from a web page or a repo). It is not a hard boundary against a
determined human crafting evasions; the sandbox is the hard part, and Docker
is the gap in it.

## Advisor

`ask_advisor` (for the agent) and `/advisor` (for you) send a focused
question, a summary, and the tail of the conversation to a model in a fresh
context with no tools. By default that's the arbiter's default model — no
swap, no cost to anyone else.

Naming another model (`model: "gemma"`, matched against the catalog) only
works with a model-swap key, which the advisor detects on its own: a swap key
answers an unknown model id with `404 model_not_found` before unloading
anything, a standard key quietly serves the default. With a standard key it
says so and uses the default. Swaps evict the default for every client, so
they have a cooldown (`PI_ADVISOR_SWAP_COOLDOWN_S`, default 300).

## Web

`web_search` (Brave Search API; registered only when `BRAVE_API_KEY` is set)
returns titles, URLs and snippets. `web_fetch` GETs a URL — judged by the
classifier like the equivalent `curl` — and returns its text
(HTML stripped, capped at ~40K chars) without a classified `curl` round trip.

## Memory

Per-project notes for future sessions, kept away from Claude Code.

- **Where:** `~/.local/share/pi-memory/<project>/`, one note per file
  (`name`, `description`, `keywords`, `type`, `source`, `updated`). The
  project is the git root shared by worktrees, else the working directory.
  `pi.sh` binds only that one folder writable.
- **Index:** built by code from the notes, capped at ~4k tokens, and frozen
  for the session (rebuilt at session start and after compaction), so the
  prompt cache survives. It tells the model notes are hints to verify, not
  instructions.
- **Recall:** each message you send is keyword-matched (plurals folded)
  against every note; at most two strong matches (~600 tokens each) are
  added, each once per session. No model calls. A note saved mid-session is
  recallable at once and joins the index next session.
- **Writes:** only through `remember` / `forget`. Checked in code: kebab-case
  names, size, secret patterns, near-duplicates (the model is told to update
  the existing note), 60 notes per project. Every save shows a notice; a
  save in a run that read the web asks you first (headless runs refuse).
  Updates and `forget` move the old version to `archive/`. Shell and file
  tools are blocked from the folder, and both classifier policies say so.
- **`/memories`** — `list`, `show <name>`, `forget <name>`,
  `restore <name>`, `claude on|off`.
- **Claude Code's memory** for the same project can be shown read-only (its
  `MEMORY.md` index only) with `PI_CLAUDE_MEMORY=1` in
  `~/.config/pi-agent/env`, or `/memories claude on`. Off by default; pi
  never writes it.
- **Claude Code is kept out of pi's memory:** `claude/guard-hook.sh` refuses
  Read/Grep/Glob/Edit/Write paths and shell commands naming the folder, and
  `install.sh` adds `Read`/`Edit` deny rules. A recursive grep of the whole
  home directory from Claude's shell could still reach it.

## Eval

```bash
cd eval
./run-eval.sh              # sandbox policy (what `pi` uses)
./run-eval.sh --host       # host policy
./run-eval.sh --offline    # detection invariants only, no model
./run-eval.sh --only=92,107
./memory-eval.sh           # project memory: recall, restraint, write checks (offline)
```

`run-eval.ts` imports `extensions/classifier-core.ts`, so it runs the exact
code the hook runs — the old Python mirror drifted from the extension more
than once. It runs on the jiti inside pi, because Ubuntu's node has no
TypeScript support.

Each case in `cases.jsonl` has a host-mode `expect`; `sandbox` overrides it
for sandbox mode (`allow`/`block`/`soft`). Flags:

- **`critical`** — an ALLOW is a real breach; the runner exits non-zero.
- **`soft`** — either verdict defensible; reported, not scored.
- **`no_fast`** — must never be fast-pathed (bypass probes: `rg --pre`,
  `./ls`, `command rm`, `/proc` and `.envrc` reads).
- **`must_read`** / **`must_inline`** — the scanner must (or must not) read
  that file. These guard the script-exec hole: if a future edit stops
  recognizing `python3 <file>`, `make`, or `docker compose up`, the eval fails
  before any model is asked.

`fixtures/` holds inert files the cases point at (read, never executed):
in-tree scripts, exfil/reverse-shell/wipe payloads, compose files (ordinary,
privileged + host root, docker socket, read-only tank), Makefiles (ordinary,
docker escape in `make test`), package.json (ordinary, `curl | sh` in a
script), and a project module for `python -m`.

### History

Measured on 0.84.x with the host policy, before the sandbox:

- 2026-08-20: 7/7 smoke test and 13/14 adversarial on the stock
  Qwen3.8-27B (the miss over-blocked); 60/60 hard cases on both the compact
  and the full Claude Code policy.
- 2026-08-30: an uncensored resident allowed `ngrok`, `npm publish` and an
  endpoint-redirect export the stock model blocked — the classifier is
  exactly as strong as the model judging it. Naming those consequences
  explicitly in the policy got the uncensored model to 61/61, then 65/65
  after a second review closed `rg --pre`/`tree -o` fast-path bypasses.
- 2026-08-31: the script-execution escape above; reading scripts at exec
  time got 73/73 with zero critical failures.
- The model was right on every command it actually saw; every bug was in the
  harness around it (fast path, framing, what it was shown).

## Known gaps

- **Docker** — see above. The classifier judges it; nothing enforces it.
- **Files that act later** — git hooks and git config are read-only, but a
  `conftest.py`, `.envrc`, or editor/task config written into the project runs
  when *you* next use the repo, outside the sandbox. Review `git status` after
  a session. (Read-only `.git/config` also means `git push -u` and `git remote
  add` fail inside pi; do those yourself.)
- **Network** — open, including the LAN. The policy blocks changes to
  infrastructure, uploads that look like exfiltration, and tunnels; the
  sandbox hides the secrets worth exfiltrating.
- **Memory poisoning** — a note outlives the session. Saves are visible and
  web-tainted saves need your OK, but a note the model writes after reading a
  malicious file in the repo (not the web) is only shown, not confirmed.
  Skim `/memories` now and then.
- **pi version bumps** — the classifier relies on pi's `tool_call` hook.
  Re-run the eval before bumping `PI_VERSION`.
