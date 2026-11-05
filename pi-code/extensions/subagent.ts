// subagent: hand independent jobs to fresh pi workers that run in parallel.
//
// Each worker is a separate pi process with its own context window, so a long
// search or review doesn't fill this session's context, and the GPU serves
// the parallel streams with more total throughput. At most PI_SUBAGENT_MAX
// (default 3) run at once.
//
// Workers run inside the same sandbox, with the same extensions: their bash
// goes through their own classifier, project extensions stay off, and memory
// is read-only for them. They get the keys the same way pi does (on a
// descriptor, not the environment) and cannot start subagents themselves.
// Web content a worker reads counts as web content for this session's memory.

import { spawn } from "node:child_process";
import { Type } from "typebox";
import { WEB_BASH, WEB_TOOLS } from "./memory.ts";
import { PLAN_STASH } from "./plan-mode.ts";
import type { Secrets } from "./secrets.ts";

const MAX_PARALLEL = Math.max(1, Math.min(4, Number(process.env.PI_SUBAGENT_MAX || "") || 3));
const MAX_TASKS = 6;
const TIMEOUT_MS = (Number(process.env.PI_SUBAGENT_TIMEOUT_S || "") || 1200) * 1000;
const RESULT_CHARS = 20_000;     // per worker
const RESULT_BUDGET = 60_000;    // all workers together (~15k tokens)
const TASK_CHARS = 32_000;

const MODES = {
  explore: {
    tools: "read,grep,find,ls,bash,web_search,web_fetch",
    prompt:
      "You are a worker started by another agent for one focused job. Do not change any files " +
      "(running tests or read-only commands is fine). " +
      "Investigate, then reply with only what the other agent needs: findings with file:line references, " +
      "short code excerpts where they matter, and what you could not determine. No preamble.",
  },
  work: {
    tools: "read,grep,find,ls,bash,edit,write",
    prompt:
      "You are a worker started by another agent for one focused job. Other workers may be running at the " +
      "same time, so change only the files your task is about. Do the task, verify it, then reply with what " +
      "you changed (files and a one-line summary each), how you verified it, and anything left undone. No preamble.",
  },
} as const;
type Mode = keyof typeof MODES;

type Result = { task: string; mode: Mode; ok: boolean; text: string; web: boolean; turns: number; error?: string };

function textOf(msg: any): string {
  if (!Array.isArray(msg?.content)) return typeof msg?.content === "string" ? msg.content : "";
  return msg.content.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n");
}

function runWorker(task: string, mode: Mode, readOnly: boolean, secrets: Secrets, ctx: any, signal: AbortSignal | undefined, onEvent: () => void, res: Result): Promise<void> {
  const args = [process.argv[1], "--mode", "json", "-p", "--no-session", "--no-approve", "--tools", MODES[mode].tools, "--append-system-prompt", MODES[mode].prompt];
  const model = ctx?.model;
  if (model?.provider && model?.id) args.push("--model", `${model.provider}/${model.id}`);
  // "Task:" prefix: a task starting with "-" or "@" would otherwise be read
  // as a flag or a file attachment.
  args.push(`Task: ${task}`);

  const mem = (globalThis as any)[Symbol.for("homelab.pi.memory")];
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.NODE_OPTIONS;
  Object.assign(env, {
    NODE_OPTIONS: "--disable-sigusr1", // as pi.sh does for pi itself: no inspector on SIGUSR1
    PI_SUBAGENT: "1",
    PI_SECRETS_FD: "3",
    PI_MEMORY_READONLY: "1",
    // Plan mode: the worker's bash gets the same read-only allowlist (plan-mode.ts).
    ...(readOnly ? { PI_SUBAGENT_READONLY: "1" } : {}),
    ...(mem?.dir ? { PI_MEMORY_DIR: mem.dir } : {}),
  });

  return new Promise((resolve) => {
    if (signal?.aborted) {
      res.error = "cancelled";
      return resolve();
    }
    let last = "";
    let stderr = "";
    let buf = "";
    let done = false;
    // Own process group, so a timeout or cancel also stops what the worker
    // started (test runners, servers), not just its Node process.
    const proc = spawn(process.execPath, args, { cwd: ctx?.cwd || process.cwd(), env, detached: true, stdio: ["ignore", "pipe", "pipe", "pipe"] });
    // Keys on fd 3, read once and closed by the worker's secrets.ts.
    const keys = proc.stdio[3] as any;
    keys?.on?.("error", () => { /* worker exited early */ });
    keys?.end?.(`PI_ARBITER_KEY=${secrets.arbiterKey}\nBRAVE_API_KEY=${secrets.braveKey}\nPI_MEMORY_KEY=${secrets.memoryKey}\n`);

    const finish = (error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      res.text = last.trim();
      res.ok = !error && !!res.text;
      if (error) res.error = error;
      else if (!res.text) res.error = stderr.trim().split("\n").slice(-5).join("\n") || "worker produced no answer";
      onEvent();
      resolve();
    };
    const killGroup = (sig: NodeJS.Signals) => {
      try { if (proc.pid) process.kill(-proc.pid, sig); } catch { try { proc.kill(sig); } catch { /* gone */ } }
    };
    const kill = () => { killGroup("SIGTERM"); setTimeout(() => killGroup("SIGKILL"), 5000).unref(); };
    const abort = () => { kill(); finish("cancelled"); };
    const timer = setTimeout(() => { kill(); finish(`timed out after ${TIMEOUT_MS / 1000}s`); }, TIMEOUT_MS);
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });

    const line = (l: string) => {
      let ev: any;
      try { ev = JSON.parse(l); } catch { return; }
      if (ev?.type === "tool_execution_start") {
        const name = String(ev.toolName || "");
        if (WEB_TOOLS.has(name) || (name === "bash" && WEB_BASH.test(String(ev.args?.command || "")))) res.web = true;
        onEvent();
      } else if (ev?.type === "message_end" && ev.message?.role === "assistant") {
        res.turns++;
        const t = textOf(ev.message);
        if (t.trim()) last = t;
        if (ev.message.stopReason === "error" && ev.message.errorMessage) stderr += `\n${ev.message.errorMessage}`;
        onEvent();
      }
    };
    proc.stdout!.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      lines.forEach(line);
    });
    proc.stderr!.on("data", (d) => { stderr = (stderr + d.toString()).slice(-4000); });
    proc.on("error", (e) => finish(String(e?.message || e)));
    proc.on("close", (code) => {
      if (buf.trim()) line(buf);
      finish(code && !last.trim() ? `exited with code ${code}` : undefined);
    });
  });
}

export default function registerSubagent(pi: any, secrets: Secrets) {
  if (process.env.PI_SUBAGENT) return; // workers don't start workers
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      `Run 1-${MAX_TASKS} independent tasks in fresh pi workers, up to ${MAX_PARALLEL} at a time, and get each worker's final answer. ` +
      "Workers start with no context: each task must be self-contained (paths, names, what to return). " +
      "mode \"explore\" (default) reads, searches, runs checks and uses the web, and is told not to edit; " +
      "mode \"work\" can also edit files.",
    promptSnippet: "Delegate independent searches, reviews or edits to parallel workers with their own context",
    // One call at a time, so two calls in one message can't double the cap.
    executionMode: "sequential",
    promptGuidelines: [
      "Use subagent for work that splits into independent parts (search several areas, review separate files, research separate questions) or would fill your context with output you only need the conclusion of. Don't use it for a single quick lookup.",
      "Write each task so a newcomer could do it: the goal, the files or areas, and exactly what to report back.",
      "Use mode \"work\" only when the tasks touch different files; check the workers' changes afterwards.",
    ],
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          task: Type.String({ description: "Self-contained instructions for the worker" }),
          mode: Type.Optional(Type.String({ description: "explore (default, no edits) or work (may edit files)" })),
        }),
        { minItems: 1, maxItems: MAX_TASKS },
      ),
    }),
    async execute(_id: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) {
      const planning = !!(globalThis as any)[PLAN_STASH]?.on;
      const tasks = (Array.isArray(params.tasks) ? params.tasks : []).slice(0, MAX_TASKS);
      if (!tasks.length) return { content: [{ type: "text", text: "No tasks given." }], isError: true, details: {} };
      const results: Result[] = tasks.map((t: any) => {
        let mode: Mode = t?.mode === "work" ? "work" : "explore";
        if (planning) mode = "explore"; // plan mode changes nothing, workers included
        return { task: String(t?.task || "").trim().slice(0, TASK_CHARS), mode, ok: false, text: "", web: false, turns: 0 };
      });
      const state = results.map(() => "queued");
      const progress = () => {
        const line = results.map((r, i) => `${i + 1}:${state[i] === "running" ? `running (${r.turns} turns)` : state[i]}`).join("  ");
        try { onUpdate?.({ content: [{ type: "text", text: `workers ${line}` }], details: { running: true } }); } catch { /* no UI */ }
      };

      let next = 0;
      const lane = async () => {
        while (next < results.length) {
          const i = next++;
          const r = results[i];
          if (!r.task) { r.error = "empty task"; state[i] = "failed"; continue; }
          if (signal?.aborted) { r.error = "cancelled"; state[i] = "cancelled"; continue; }
          state[i] = "running";
          progress();
          await runWorker(r.task, r.mode, planning, secrets, ctx, signal, progress, r);
          state[i] = r.ok ? "done" : "failed";
          progress();
        }
      };
      await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, results.length) }, lane));

      const web = results.some((r) => r.web);
      if (web) (globalThis as any)[Symbol.for("homelab.pi.memory.webTaint")]?.();
      const perWorker = Math.min(RESULT_CHARS, Math.floor(RESULT_BUDGET / results.length));
      const body = results.map((r, i) => {
        const head = `## Worker ${i + 1} (${r.mode}) — ${r.ok ? "done" : `failed: ${r.error}`}`;
        let text = r.text || "(no answer)";
        if (text.length > perWorker) text = `${text.slice(0, perWorker)}\n… (truncated)`;
        return `${head}\nTask: ${r.task.slice(0, 300)}${r.task.length > 300 ? "…" : ""}\n\n${text}`;
      }).join("\n\n");
      const note = planning && tasks.some((t: any) => t?.mode === "work") ? "\n\n(Plan mode is on, so every worker ran in explore mode.)" : "";
      return {
        content: [{ type: "text", text: body + note }],
        isError: results.every((r) => !r.ok),
        details: { web, results: results.map((r) => ({ mode: r.mode, ok: r.ok, turns: r.turns, error: r.error, web: r.web })) },
      };
    },
  });
}
