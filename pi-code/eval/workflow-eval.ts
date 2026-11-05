// Offline tests for the workflow extensions: plan mode's read-only bash
// allowlist and lint feedback on real files.
// No model calls. Run: ./workflow-eval.sh

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { isReadOnlyCommand } from "../extensions/plan-mode.ts";
import registerLint, { newProblems } from "../extensions/lint.ts";
import registerTodo, { fromBranch, problems, render } from "../extensions/todo.ts";
import registerUndo, { Store } from "../extensions/undo.ts";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${String(detail)}`}`);
}

// ---- plan mode: what bash may run
const allowed = [
  "ls -la src",
  "grep -rn 'foo|bar' src | head -20",
  "git log --oneline -10 && git status",
  "cat package.json | jq .scripts",
  "rg -n \"=>\" src 2>/dev/null",
  "find . -name '*.ts' -not -path './node_modules/*'",
  "sed -n 1,40p README.md",
  "docker compose ps",
  "systemctl status nginx",
  "curl -s https://example.com | head",
  "grep x file 2>&1 | head",
  "wc -l src/*.ts; echo done",
  "echo 'a > b'",
  "git grep -i todo",
  "git branch -a",
  "sed -n '/we/p' notes.txt",
]
const blocked = [
  "rm -rf build",
  "echo hi > notes.txt",
  "cat a >> b",
  "grep x f 2>err.log",
  "sed -i s/a/b/ file",
  "find . -name '*.tmp' -delete",
  "find . -exec rm {} \\;",
  "git commit -am wip",
  "npm install left-pad",
  "ls $(touch pwned)",
  "echo \"$(rm -rf x)\"",
  "ls `id`",
  "cat x | tee out",
  "curl -o out.bin https://example.com",
  "curl -X POST -d a=1 https://example.com",
  "python3 script.py",
  "make build",
  "ls; ./deploy.sh",
  "ls & rm x",
  "awk 'BEGIN{system(\"id\")}'",
  "ls | xargs rm",
  "diff <(ls a) <(ls b)",
  "awk '{print > \"out\"}' f",
  "sed -n '1w out' f",
  "sed -n '1e id' f",
  "git branch -D main",
  "git remote add x url",
  "sort -o f f",
  "yq -i '.a=1' f.yml",
];
for (const c of allowed) check(`plan allows: ${c}`, isReadOnlyCommand(c));
for (const c of blocked) check(`plan blocks: ${c}`, !isReadOnlyCommand(c));

// ---- lint: run the real hook against real files
let handler: any;
const fakePi = {
  on: (ev: string, fn: any) => { if (ev === "tool_result") handler = fn; },
  exec: (cmd: string, args: string[], opts: any) =>
    new Promise((resolve) => {
      execFile(cmd, args, { timeout: opts?.timeout, cwd: opts?.cwd }, (err: any, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr, killed: !!err?.killed });
      });
    }),
};
registerLint(fakePi);
check("lint registers a tool_result hook", typeof handler === "function");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-eval-"));
const files: [string, string, boolean][] = [
  ["bad.sh", "#!/bin/bash\nif [ -f x ]; then\n  echo hi\n", true],
  ["good.sh", "#!/bin/bash\nset -euo pipefail\necho \"hi\"\n", false],
  ["bad.py", "def f(:\n    return 1\n", true],
  ["good.py", "def f(x):\n    return x + 1\n", false],
  ["bad.json", "{\"a\": 1,}\n", true],
  ["good.json", "{\"a\": 1}\n", false],
  ["bad.yml", "a: [1, 2\nb: 3\n", true],
  ["good.yml", "a: [1, 2]\nb: 3\n", false],
  ["bad.js", "function (\n", true],
  ["good.js", "export const x = 1;\n", false],
  ["noext-script", "#!/usr/bin/env bash\nfi\n", true],
  ["notes.md", "# not checked > at all (\n", false],
  ["zsh-script", "#!/usr/bin/env zsh\nfor f (*.txt) print $f\n", false],
];
for (const [name, body, bad] of files) {
  fs.writeFileSync(path.join(dir, name), body);
  const r = await handler(
    { toolName: name.startsWith("good") ? "write" : "edit", input: { path: name }, content: [{ type: "text", text: "ok" }], isError: false },
    { cwd: dir },
  );
  const added = r?.content?.map((c: any) => c.text).join("") || "";
  check(`lint ${bad ? "flags" : "passes"} ${name}`, bad ? /Lint found problems/.test(added) : r === undefined, added.slice(0, 200) || "no result");
}
const errResult = await handler({ toolName: "edit", input: { path: "bad.sh" }, content: [], isError: true }, { cwd: dir });
check("lint skips failed edits", errResult === undefined);
const readResult = await handler({ toolName: "read", input: { path: "bad.sh" }, content: [], isError: false }, { cwd: dir });
check("lint ignores other tools", readResult === undefined);
fs.rmSync(dir, { recursive: true, force: true });

// ---- lint baseline: only problems the edit added
const before = "a.sh:3:1: warning: Double quote to prevent globbing [SC2086]\na.sh:9:5: warning: x is unused [SC2034]";
const after = "a.sh:4:1: warning: Double quote to prevent globbing [SC2086]\na.sh:10:5: warning: x is unused [SC2034]\na.sh:12:1: warning: y is unused [SC2034]";
check("lint baseline drops warnings that only moved", newProblems(after, before) === "a.sh:12:1: warning: y is unused [SC2034]", newProblems(after, before));
check("lint baseline keeps everything for a new file", newProblems(after, undefined) === after);
check("lint baseline counts repeats", newProblems("f:1: w A\nf:2: w A", "f:1: w A") === "f:2: w A", newProblems("f:1: w A\nf:2: w A", "f:1: w A"));

// ---- shared fake pi
function fakeExtPi() {
  const tools = new Map<string, any>(), cmds = new Map<string, any>(), handlers = new Map<string, any[]>();
  const entries: any[] = [], messages: any[] = [];
  const pi = {
    registerTool: (t: any) => tools.set(t.name, t),
    registerCommand: (n: string, c: any) => cmds.set(n, c),
    on: (ev: string, fn: any) => { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev)!.push(fn); },
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    sendMessage: (m: any) => messages.push(m),
  };
  const emit = async (ev: string, e: any, ctx: any) => { for (const h of handlers.get(ev) || []) await h(e, ctx); };
  return { pi, tools, cmds, entries, messages, emit };
}
const textOf = (r: any) => r?.content?.map((c: any) => c.text).join("") || "";

// ---- todo_write
{
  check("todo: a valid list passes", problems([{ content: "a", status: "pending" }, { content: "b", status: "in_progress" }]) === "");
  check("todo: two in_progress refused", /only one/.test(problems([{ content: "a", status: "in_progress" }, { content: "b", status: "in_progress" }])));
  check("todo: unknown status refused", /status/.test(problems([{ content: "a", status: "doing" }])));
  check("todo: empty content refused", /no content/.test(problems([{ content: " ", status: "pending" }])));
  check("todo: too many refused", /at most/.test(problems(Array.from({ length: 31 }, () => ({ content: "x", status: "pending" })))));
  const f = fakeExtPi();
  registerTodo(f.pi);
  let widget: any = "unset";
  const ctx = { hasUI: true, ui: { setWidget: (_k: string, v: any) => { widget = v; }, notify: () => {} }, sessionManager: { getBranch: () => [] } };
  await f.emit("session_start", {}, ctx);
  const tw = f.tools.get("todo_write");
  const r1 = await tw.execute("1", { todos: [{ content: "Write the parser", status: "in_progress" }, { content: "Add  tests", status: "pending" }] }, undefined, undefined, ctx);
  check("todo: list shown above the editor", Array.isArray(widget) && widget[0] === "Tasks 0/2" && widget[1] === "◐ Write the parser" && widget[2] === "☐ Add tests", widget);
  check("todo: result says what's in progress", /0\/2 done.*Working on: Write the parser/.test(textOf(r1)), textOf(r1));
  const bad = await tw.execute("2", { todos: [{ content: "x", status: "in_progress" }, { content: "y", status: "in_progress" }] }, undefined, undefined, ctx);
  check("todo: a refused update keeps the old list", bad.isError === true && bad.details.todos.length === 2 && widget[0] === "Tasks 0/2");
  const r3 = await tw.execute("3", { todos: [{ content: "Write the parser", status: "completed" }, { content: "Add tests", status: "completed" }] }, undefined, undefined, ctx);
  check("todo: all done folds to one line", /All 2 tasks completed/.test(textOf(r3)) && widget.length === 1 && /2\/2 done/.test(widget[0]), widget);
  // The list follows the branch: rebuilt from the last good result on it.
  const branch = [
    { type: "message", message: { role: "toolResult", toolName: "todo_write", details: r1.details } },
    { type: "message", message: { role: "toolResult", toolName: "todo_write", isError: true, details: { todos: [] } } },
  ];
  check("todo: rebuilt from the branch, errors ignored", fromBranch(branch).length === 2 && fromBranch(branch)[0].status === "in_progress");
  await f.emit("session_tree", {}, { ...ctx, sessionManager: { getBranch: () => branch } });
  check("todo: /tree shows that branch's list", Array.isArray(widget) && widget[0] === "Tasks 0/2", widget);
  check("todo: render marks", render([{ content: "a", status: "completed" }])[1] === "☑ a");
}

// ---- undo
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "undo-eval-"));
  const proj = path.join(root, "proj");
  fs.mkdirSync(path.join(proj, "src"), { recursive: true });
  fs.writeFileSync(path.join(proj, "src/app.py"), "print('v1')\n");
  fs.writeFileSync(path.join(proj, "README.md"), "hello\n");
  fs.writeFileSync(path.join(proj, ".gitignore"), "build/\n");
  fs.mkdirSync(path.join(proj, "build"));
  fs.writeFileSync(path.join(proj, "build/out.bin"), "keep me");
  // The project's own repo must stay untouched by undo.
  execFileSync("git", ["init", "-q", proj]);
  const projGitHead = fs.readFileSync(path.join(proj, ".git/HEAD"), "utf8");
  process.env.PI_PROJECT_DIR = proj;
  process.env.PI_UNDO_DIR = path.join(root, "undo");
  const f = fakeExtPi();
  registerUndo(f.pi);
  const notes: string[] = [];
  let pickIndex = 0, confirmAnswer = true, lastConfirm = "";
  const ctx: any = {
    hasUI: true, isIdle: () => true,
    sessionManager: { getEntries: () => f.entries },
    ui: {
      notify: (m: string) => notes.push(m),
      select: async (_t: string, opts: string[]) => opts[pickIndex],
      confirm: async (t: string, body: string) => { lastConfirm = `${t}\n${body}`; return confirmAnswer; },
    },
  };
  await f.emit("session_start", {}, ctx);
  await f.emit("before_agent_start", { messageType: "user", prompt: "make it v2" }, ctx);
  check("undo: a snapshot before each prompt", f.entries.length === 1 && /^[0-9a-f]{40}$/.test(f.entries[0].data.commit));
  await f.emit("before_agent_start", { messageType: "custom" }, ctx);
  check("undo: no snapshot for runs not started by a prompt", f.entries.length === 1);
  // The "agent" changes things every way it can.
  fs.writeFileSync(path.join(proj, "src/app.py"), "print('v2')\n");
  fs.writeFileSync(path.join(proj, "src/new.py"), "x = 1\n");
  fs.rmSync(path.join(proj, "README.md"));
  fs.writeFileSync(path.join(proj, "build/out.bin"), "changed build");
  // ... and plants an fsmonitor command in the undo store, which must never run.
  const marker = path.join(root, "pwned");
  fs.appendFileSync(path.join(root, "undo/store.git/config"), `[core]\n\tfsmonitor = touch ${marker}\n`);
  fs.mkdirSync(path.join(root, "undo/store.git/hooks"), { recursive: true });
  fs.writeFileSync(path.join(root, "undo/store.git/hooks/post-checkout"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  confirmAnswer = false;
  await f.cmds.get("undo").handler("", ctx);
  check("undo: confirm lists what changes", /Undo 3 file changes/.test(lastConfirm) && /revert +src\/app\.py/.test(lastConfirm) && /delete +src\/new\.py/.test(lastConfirm) && /restore README\.md/.test(lastConfirm), lastConfirm);
  check("undo: declined changes nothing", fs.readFileSync(path.join(proj, "src/app.py"), "utf8") === "print('v2')\n" && fs.existsSync(path.join(proj, "src/new.py")));
  confirmAnswer = true;
  await f.cmds.get("undo").handler("", ctx);
  check("undo: files restored, new file removed, deleted file back",
    fs.readFileSync(path.join(proj, "src/app.py"), "utf8") === "print('v1')\n" && !fs.existsSync(path.join(proj, "src/new.py")) && fs.readFileSync(path.join(proj, "README.md"), "utf8") === "hello\n");
  check("undo: ignored files untouched", fs.readFileSync(path.join(proj, "build/out.bin"), "utf8") === "changed build");
  check("undo: the project's own .git untouched", fs.readFileSync(path.join(proj, ".git/HEAD"), "utf8") === projGitHead && !fs.existsSync(path.join(proj, ".git/refs/heads/undo")));
  check("undo: planted fsmonitor/hook never ran", !fs.existsSync(marker));
  check("undo: the model is told", f.messages.length === 1 && /back to how they were before the prompt "make it v2"/.test(f.messages[0].content) && /src\/new\.py/.test(f.messages[0].content), f.messages[0]?.content);
  // The undo can itself be undone: newest checkpoint is "just before undoing".
  pickIndex = 0;
  await f.cmds.get("undo").handler("", ctx);
  check("undo: undoing the undo brings the changes back",
    fs.readFileSync(path.join(proj, "src/app.py"), "utf8") === "print('v2')\n" && fs.existsSync(path.join(proj, "src/new.py")) && !fs.existsSync(path.join(proj, "README.md")));
  // Nothing changed since a checkpoint: says so.
  await f.emit("before_agent_start", { messageType: "user", prompt: "noop" }, ctx);
  notes.length = 0; pickIndex = 0;
  await f.cmds.get("undo").handler("", ctx);
  check("undo: nothing to undo when nothing changed", notes.some((n) => /nothing to undo/.test(n)), notes);
  // Resume: checkpoints come back from the session's entries.
  const f2 = fakeExtPi();
  registerUndo(f2.pi);
  f2.entries.push(...f.entries);
  await f2.emit("session_start", {}, { ...ctx, sessionManager: { getEntries: () => f2.entries } });
  let labels: string[] = [];
  await f2.cmds.get("undo").handler("", { ...ctx, ui: { ...ctx.ui, select: async (_t: string, o: string[]) => { labels = o; return undefined; } } });
  check("undo: checkpoints survive /resume and /reload", labels.length === f.entries.length && /make it v2/.test(labels[labels.length - 1]), labels);
  // Not for workers, routine runs or read-only sessions.
  for (const [k, v] of [["PI_SUBAGENT", "1"], ["PI_ROUTINE", "x"]]) {
    process.env[k] = v;
    const g = fakeExtPi(); registerUndo(g.pi);
    check(`undo: off when ${k} is set`, !g.cmds.has("undo"));
    delete process.env[k];
  }
  process.env.PI_PROJECT_DIR = "none — read-only session";
  { const g = fakeExtPi(); registerUndo(g.pi); check("undo: off in a read-only session", !g.cmds.has("undo")); }
  // Store.size counts what would be snapshotted (not ignored files).
  const sz = new Store(path.join(root, "undo/store.git"), proj).size();
  check("undo: size skips ignored files", !!sz && sz.files === 3, sz);
  delete process.env.PI_PROJECT_DIR; delete process.env.PI_UNDO_DIR;
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`----\npass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
