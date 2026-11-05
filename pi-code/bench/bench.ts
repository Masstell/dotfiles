// pi coding bench: synthetic coding tasks, each run by pi with nobody
// watching (the real launcher: sandbox, classifier, the local model), in a
// throwaway copy of a small repo, then graded by tests pi never saw.
// It answers "did that change make pi better or worse?" with numbers instead
// of impressions: pass rate, time, tool calls, and whether pi kept a task list.
//
//   bench.sh                  run every task once
//   bench.sh --only a,b       some tasks
//   bench.sh --tag hard       tasks with that tag (the fuzz-graded ones are tagged hard)
//   bench.sh --repeat 3       each task 3 times (local models vary run to run)
//   bench.sh --parallel 2     tasks at once (the arbiter is shared; default 1)
//   bench.sh --selftest       no model: check every task fails as given and
//                             passes with its reference solution
//   bench.sh --list           the tasks
//
// Each task (tasks/<id>/): task.json {prompt, check, timeoutMin?, tags?},
// repo/ (what pi gets), hidden/ (tests copied in after pi is done, replacing
// any pi edited, so changing the tests can't pass a task), solution/ (files
// that solve it, for --selftest). Results: ~/pi-bench/results/<time>.json,
// compared with the previous run's.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TASKS = path.join(HERE, "tasks");
const PI = process.env.PI_LAUNCHER || path.resolve(HERE, "../pi.sh");
// Under home but not hidden: pi.sh makes it a writable project.
const ROOT = process.env.PI_BENCH_DIR || path.join(os.homedir(), "pi-bench");
const CHECK_TIMEOUT_MS = 180_000;

type Task = { id: string; dir: string; prompt: string; check: string; timeoutMin: number; tags: string[] };
type Result = {
  task: string; attempt: number; pass: boolean; seconds: number; toolCalls: number; tools: Record<string, number>;
  usedTodo: boolean; turns: number; error?: string; checkOutput?: string; diff?: string;
  finalText?: string; // pi's last words: why it stopped, what it thinks it did
};

function args() {
  const a = process.argv.slice(2);
  const val = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  return {
    only: val("--only")?.split(",").map((s) => s.trim()).filter(Boolean),
    tag: val("--tag"),
    repeat: Math.max(1, Number(val("--repeat") || 1)),
    parallel: Math.max(1, Math.min(4, Number(val("--parallel") || 1))),
    selftest: a.includes("--selftest"),
    list: a.includes("--list"),
  };
}

function loadTasks(only?: string[], tag?: string): Task[] {
  const ids = fs.readdirSync(TASKS).filter((d) => fs.existsSync(path.join(TASKS, d, "task.json"))).sort();
  const unknown = (only || []).filter((o) => !ids.includes(o));
  if (unknown.length) throw new Error(`unknown task(s): ${unknown.join(", ")}`);
  const tasks = ids.filter((id) => !only || only.includes(id)).map((id) => {
    const j = JSON.parse(fs.readFileSync(path.join(TASKS, id, "task.json"), "utf8"));
    return { id, dir: path.join(TASKS, id), prompt: j.prompt, check: j.check, timeoutMin: j.timeoutMin || 10, tags: j.tags || [] };
  });
  const picked = tag ? tasks.filter((t) => t.tags.includes(tag)) : tasks;
  if (!picked.length) throw new Error(`no tasks${tag ? ` tagged ${tag}` : ""}`);
  return picked;
}

const sh = (cmd: string, cwd: string, timeout = CHECK_TIMEOUT_MS) =>
  spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8", timeout, maxBuffer: 16 << 20, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });

/** A fresh copy of the task's repo, as a git repo with one commit (so the diff shows what pi did). */
function prepare(t: Task, work: string) {
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(work), { recursive: true });
  fs.cpSync(path.join(t.dir, "repo"), work, { recursive: true });
  const g = (a: string) => sh(`git -c user.name=bench -c user.email=bench@pi ${a}`, work);
  g("init -q"); g("add -A"); g("commit -q -m start");
}

/** Copy hidden tests in and run the task's check. */
function grade(t: Task, work: string): { pass: boolean; output: string } {
  const hidden = path.join(t.dir, "hidden");
  if (fs.existsSync(hidden)) fs.cpSync(hidden, work, { recursive: true, force: true });
  const r = sh(t.check, work);
  const output = `${r.stdout || ""}${r.stderr || ""}${r.error ? `\n${r.error.message}` : ""}`.trim();
  return { pass: r.status === 0, output: output.slice(-2000) };
}

function runPi(t: Task, work: string): Promise<Omit<Result, "task" | "attempt" | "pass" | "checkOutput" | "diff">> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tools: Record<string, number> = {};
    let turns = 0, buf = "", err = "", lastStop = "", lastError = "", lastText = "", done = false;
    const child = spawn(PI, ["--mode", "json", "-p", "--no-session", t.prompt], {
      cwd: work, stdio: ["ignore", "pipe", "pipe"], detached: true,
      env: { ...process.env, PI_BENCH: "1" },
    });
    const finish = (error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const toolCalls = Object.values(tools).reduce((a, b) => a + b, 0);
      resolve({ seconds: Math.round((Date.now() - start) / 1000), toolCalls, tools, usedTodo: !!tools.todo_write, turns, error, finalText: lastText.slice(-1500) || undefined });
    };
    const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } finish(`timed out after ${t.timeoutMin} min`); }, t.timeoutMin * 60_000);
    child.stdout.on("data", (d) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let ev: any; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "tool_execution_start") tools[ev.toolName] = (tools[ev.toolName] || 0) + 1;
        else if (ev.type === "turn_start") turns++;
        else if (ev.type === "message_end" && ev.message?.role === "assistant") {
          lastStop = ev.message.stopReason || ""; lastError = ev.message.errorMessage || "";
          const t = Array.isArray(ev.message.content) ? ev.message.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n").trim() : "";
          if (t) lastText = t;
        }
      }
    });
    child.stderr.on("data", (d) => { if (err.length < 4000) err += d; });
    child.on("error", (e) => finish(`could not start pi: ${e.message}`));
    child.on("close", (code) => finish(code !== 0 ? `pi exited with ${code}: ${err.trim().split("\n").slice(-3).join(" | ")}`
      : lastStop === "error" ? `model error: ${lastError}` : undefined));
  });
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  const q = [...items];
  await Promise.all(Array.from({ length: n }, async () => { for (let x = q.shift(); x !== undefined; x = q.shift()) await fn(x); }));
}

function selftest(tasks: Task[]): number {
  let bad = 0;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bench-self-"));
  for (const t of tasks) {
    const work = path.join(tmp, t.id);
    prepare(t, work);
    const before = grade(t, work);
    prepare(t, work);
    fs.cpSync(path.join(t.dir, "solution"), work, { recursive: true, force: true });
    const after = grade(t, work);
    const ok = !before.pass && after.pass;
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "BAD "} ${t.id}${before.pass ? "  (passes as given: the task tests nothing)" : ""}${!after.pass ? `  (reference solution fails:\n${after.output}\n)` : ""}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`----\n${tasks.length - bad}/${tasks.length} tasks are sound`);
  return bad ? 1 : 0;
}

function previous(resultsDir: string): Result[] | undefined {
  try {
    const f = fs.readdirSync(resultsDir).filter((x) => x.endsWith(".json")).sort().pop();
    return f ? JSON.parse(fs.readFileSync(path.join(resultsDir, f), "utf8")).results : undefined;
  } catch { return undefined; }
}

function rate(rs: Result[]) { return rs.length ? rs.filter((r) => r.pass).length / rs.length : 0; }

async function main() {
  const o = args();
  const tasks = loadTasks(o.only, o.tag);
  if (o.list) { for (const t of tasks) console.log(`${t.id.padEnd(26)} ${t.tags.join(",").padEnd(22)} ${t.prompt.replace(/\s+/g, " ").slice(0, 90)}`); return 0; }
  if (o.selftest) return selftest(tasks);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = path.join(ROOT, "runs", stamp);
  const resultsDir = path.join(ROOT, "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const prev = previous(resultsDir);
  const jobs = tasks.flatMap((t) => Array.from({ length: o.repeat }, (_, i) => ({ t, attempt: i + 1 })));
  const results: Result[] = [];
  console.log(`pi bench: ${tasks.length} tasks × ${o.repeat}, ${o.parallel} at a time; work in ${runDir}`);
  await pool(jobs, o.parallel, async ({ t, attempt }) => {
    const work = path.join(runDir, o.repeat > 1 ? `${t.id}-${attempt}` : t.id);
    prepare(t, work);
    const ran = await runPi(t, work);
    const diff = (sh("git add -A >/dev/null 2>&1; git diff --cached --shortstat", work).stdout || "").trim();
    const g = grade(t, work);
    const r: Result = { task: t.id, attempt, ...ran, pass: g.pass, checkOutput: g.pass ? undefined : g.output, diff };
    results.push(r);
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${t.id}${o.repeat > 1 ? ` #${attempt}` : ""}  ${r.seconds}s, ${r.toolCalls} tool calls${r.usedTodo ? ", task list" : ""}${r.error ? `  -- ${r.error}` : ""}`);
  });

  results.sort((a, b) => a.task.localeCompare(b.task) || a.attempt - b.attempt);
  const file = path.join(resultsDir, `${stamp}.json`);
  const meta = { time: new Date().toISOString(), host: os.hostname(), repeat: o.repeat, tasks: tasks.map((t) => t.id) };
  fs.writeFileSync(file, JSON.stringify({ ...meta, results }, null, 2) + "\n");

  console.log("\ntask                        pass   time  tools" + (prev ? "   before" : ""));
  for (const t of tasks) {
    const rs = results.filter((r) => r.task === t.id);
    const ps = prev?.filter((r) => r.task === t.id) || [];
    const avg = (f: (r: Result) => number) => Math.round(rs.reduce((a, r) => a + f(r), 0) / rs.length);
    console.log(`${t.id.padEnd(27)} ${`${rs.filter((r) => r.pass).length}/${rs.length}`.padStart(5)} ${`${avg((r) => r.seconds)}s`.padStart(6)} ${String(avg((r) => r.toolCalls)).padStart(6)}` +
      (ps.length ? `   ${ps.filter((r) => r.pass).length}/${ps.length}` : prev ? "   -" : ""));
  }
  const todoBig = results.filter((r) => tasks.find((t) => t.id === r.task)?.tags.includes("multi-step"));
  console.log(`\nScore: ${Math.round(rate(results) * 100)}% (${results.filter((r) => r.pass).length}/${results.length})` +
    (prev ? `, previous run ${Math.round(rate(prev.filter((r) => tasks.some((t) => t.id === r.task))) * 100)}%` : "") +
    (todoBig.length ? `. Task list used on ${todoBig.filter((r) => r.usedTodo).length}/${todoBig.length} multi-step runs.` : ""));
  console.log(`Results: ${file}\nWork dirs (pi's changes, as git diffs): ${runDir}`);
  return 0;
}

main().then((c) => process.exit(c), (e) => { console.error(`pi bench: ${e.message}`); process.exit(2); });
