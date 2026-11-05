// Offline tests for the workflow extensions: plan mode's read-only bash
// allowlist and lint feedback on real files.
// No model calls. Run: ./workflow-eval.sh

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { isReadOnlyCommand } from "../extensions/plan-mode.ts";
import registerLint, { newProblems } from "../extensions/lint.ts";

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

console.log(`----\npass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
