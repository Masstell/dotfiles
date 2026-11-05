// Lint feedback: after a successful edit or write, check the file and add any
// problems to the tool result, so the model fixes them in the same turn
// instead of finding out three steps later.
//
// Only fixed system checkers run, never anything from the project (a
// project's node_modules/.bin or .venv). Those run outside the bash
// classifier, so the agent could plant one and have it run unchecked.
// A checker that isn't installed is skipped; built-in syntax checks (bash -n,
// Python ast, node --check, JSON and YAML parsing) cover the common cases
// without extra packages. PI_LINT=0 turns this off.

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

const OFF = /^(0|false|no|off)$/i;
const TIMEOUT_MS = 15_000;
const MAX_CHARS = 3_000;
const MAX_BYTES = 2_000_000; // skip huge or generated files

type Check = { label: string; cmd: string; args: (file: string) => string[] };

const which = new Map<string, string | null>();
function find(cmd: string): string | null {
  if (cmd.startsWith("/")) return existsSync(cmd) ? cmd : null;
  if (which.has(cmd)) return which.get(cmd)!;
  // System locations only: PATH may include project or user-writable dirs.
  const hit = ["/usr/local/bin", "/usr/bin", "/bin"].map((d) => path.join(d, cmd)).find((p) => existsSync(p)) ?? null;
  which.set(cmd, hit);
  return hit;
}

const PY_AST = "import ast,sys\nsrc=open(sys.argv[1],encoding='utf-8').read()\ntry:\n ast.parse(src,sys.argv[1])\nexcept SyntaxError as e:\n print(f'{e.filename}:{e.lineno}:{e.offset}: {e.msg}'); sys.exit(1)";
const PY_YAML = "import sys\ntry:\n import yaml\nexcept ImportError:\n sys.exit(0)\ntry:\n list(yaml.safe_load_all(open(sys.argv[1],encoding='utf-8')))\nexcept yaml.YAMLError as e:\n print(e); sys.exit(1)";

// Per file type: the first installed checker in each group runs.
const CHECKS: Record<string, Check[][]> = {
  sh: [
    [{ label: "bash -n", cmd: "bash", args: (f) => ["-n", f] }],
    [{ label: "shellcheck", cmd: "shellcheck", args: (f) => ["-f", "gcc", "-S", "warning", f] }],
  ],
  py: [
    [
      { label: "ruff", cmd: "ruff", args: (f) => ["check", "--quiet", "--output-format", "concise", "--no-cache", f] },
      { label: "python syntax", cmd: "python3", args: (f) => ["-I", "-c", PY_AST, f] },
    ],
  ],
  js: [[{ label: "node --check", cmd: "node", args: (f) => ["--check", f] }]],
  yaml: [
    [
      { label: "yamllint", cmd: "yamllint", args: (f) => ["-f", "parsable", "-d", "{extends: relaxed, rules: {line-length: disable}}", f] },
      { label: "yaml parse", cmd: "python3", args: (f) => ["-I", "-c", PY_YAML, f] },
    ],
  ],
  // gofmt exits non-zero only on syntax errors; a file that just needs
  // formatting is listed with exit 0, which isn't worth a turn.
  go: [[{ label: "gofmt", cmd: "gofmt", args: (f) => ["-l", "-e", f] }]],
};

function kindOf(file: string): string | null {
  const ext = path.extname(file).toLowerCase();
  if ([".sh", ".bash"].includes(ext)) return "sh";
  if (ext === ".py") return "py";
  if ([".js", ".mjs", ".cjs"].includes(ext)) return "js";
  if ([".yml", ".yaml"].includes(ext)) return "yaml";
  if (ext === ".go") return "go";
  if (ext === ".json") return "json";
  if (ext === "") {
    // Scripts without an extension: go by the shebang.
    try {
      const head = readFileSync(file, { encoding: "utf8", flag: "r" }).slice(0, 80);
      if (/^#!.*\b(ba|da|z)?sh\b/.test(head)) return "sh";
      if (/^#!.*\bpython[0-9.]*\b/.test(head)) return "py";
      if (/^#!.*\bnode\b/.test(head)) return "js";
    } catch { /* unreadable */ }
  }
  return null;
}

export function jsonProblem(text: string): string | null {
  try { JSON.parse(text); return null; } catch (e: any) { return String(e?.message || e); }
}

export default function registerLint(pi: any) {
  if (OFF.test(process.env.PI_LINT || "")) return;

  pi.on("tool_result", async (event: any, ctx: any) => {
    if (event?.isError || !["edit", "write"].includes(String(event?.toolName))) return;
    const raw = String(event?.input?.path || event?.input?.file_path || "").replace(/^@/, "");
    if (!raw) return;
    const file = path.resolve(ctx?.cwd || process.cwd(), raw);
    const kind = kindOf(file);
    if (!kind) return;
    let size = 0;
    try { size = readFileSync(file).length; } catch { return; }
    if (size > MAX_BYTES) return;

    const problems: string[] = [];
    if (kind === "json") {
      const p = jsonProblem(readFileSync(file, "utf8"));
      if (p) problems.push(`[json parse] ${p}`);
    } else {
      for (const group of CHECKS[kind] || []) {
        const check = group.find((c) => find(c.cmd));
        if (!check) continue;
        try {
          const r = await pi.exec(find(check.cmd)!, check.args(file), { timeout: TIMEOUT_MS, signal: ctx?.signal, cwd: path.dirname(file) });
          const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
          if (r.code !== 0 && out && !r.killed) problems.push(`[${check.label}]\n${out}`);
        } catch { /* checker failed to start: skip */ }
      }
    }
    if (!problems.length) return;
    let text = problems.join("\n\n");
    if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}\n… (truncated)`;
    const content = Array.isArray(event.content) ? [...event.content] : [];
    content.push({ type: "text", text: `\n\nLint found problems in ${raw} (the edit itself was applied):\n${text}\nFix these unless they are intended.` });
    return { content };
  });
}
