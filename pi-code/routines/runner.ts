// pi-routines: the service that fires routines (extensions/routines.ts).
//
// Runs as the owner (systemd, from the Ansible vm_base role), outside the
// sandbox, and starts each run through this repo's launcher (pi.sh), so every
// run gets the sandbox, the classifier and the keys exactly as an interactive
// pi does. Only routines signed with the owner's routine key run.
//
// Each minute: routines whose cron matches (in their own time zone), plus any
// asked to run now (<name>.run, at most once per RUN_NOW_GAP), are started —
// at most MAX_PARALLEL at once (the arbiter is shared), never two runs of one
// routine. A run's notify calls reach the owner as one message (through the
// machine's notify command, below); so does a run that fails to finish (once,
// until one finishes again), and any routine that appears, disappears or is
// refused. Minutes missed while the VM was down are
// not made up. Around DST changes it behaves like cron: a job pinned to an
// hour runs once when the clock falls back, and one skipped when it springs
// forward runs right after the gap.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { everyHour, matchesWall, nextWall, parseCron, wallClock, wallKey, type Wall } from "../extensions/cron.ts";
import {
  NOTES_MAX, NOTE_CHARS, SUMMARY_CHARS, atomicWrite, loadRoutines, readLedger, readRegular, readState, routinesDir,
  runPrompt, writeLedger, writeState, type Ledger, type RoutineState, type SignedRoutine,
} from "../extensions/routines-core.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const HOME = os.homedir();
const HOST = os.hostname();
const MAX_PARALLEL = Math.max(1, Math.min(4, Number(process.env.PI_ROUTINES_MAX || "") || 2));
// This repo's launcher by absolute path: not whatever `pi` PATH finds.
const PI = process.env.PI_LAUNCHER || path.resolve(HERE, "../pi.sh");
const KEY_FILE = path.join(HOME, ".config/pi-agent/routine.key");
const RUN_NOW_GAP_MS = 5 * 60_000;
const POSTS_PER_HOUR = 6;
const BODY_MAX = 3000;

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- run parsing

function textOf(msg: any): string {
  if (!Array.isArray(msg?.content)) return typeof msg?.content === "string" ? msg.content : "";
  return msg.content.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n");
}

export type RunResult = { ok: boolean; error?: string; summary: string; notes: string[]; lastError?: string };

/** Fold one pi --mode json event line into a run's result. Only the last
 *  assistant message decides whether the run ended in an error (pi retries). */
export function foldEvent(r: RunResult, line: string) {
  let ev: any;
  try { ev = JSON.parse(line); } catch { return; }
  if (ev?.type === "tool_execution_start" && ev.toolName === "notify") {
    const m = String(ev.args?.message || "").trim();
    if (m && r.notes.length < NOTES_MAX) r.notes.push(m.slice(0, NOTE_CHARS));
  } else if (ev?.type === "message_end" && ev.message?.role === "assistant") {
    const t = textOf(ev.message).trim();
    if (t) r.summary = t;
    r.lastError = ev.message.stopReason === "error" ? String(ev.message.errorMessage || "model error") : undefined;
  }
}

/** Defuse chat mentions (@room, @user:server) in text a run produced. */
export function defuse(t: string): string {
  return t.replace(/@/g, "@​");
}

type Msg = { text: string; kind: "note" | "fail" | "ok" };
/** What to post after a run, given the previous state. */
export function alertsFor(name: string, prev: RoutineState, res: RunResult): Msg[] {
  const messages: Msg[] = [];
  if (res.notes.length) messages.push({ kind: "note", text: `🔔 ${HOST} · ${name}: ${defuse(res.notes.join(" | "))}` });
  if (!res.ok && !prev.failing) messages.push({ kind: "fail", text: `⚠️ ${HOST} · routine ${name} could not run: ${defuse(res.error || "?")}` });
  if (res.ok && prev.failing) messages.push({ kind: "ok", text: `✅ ${HOST} · routine ${name} is running again.` });
  return messages;
}

// ---------------------------------------------------------------- process tree

function killTree(pid: number, sig: NodeJS.Signals) {
  const kids = new Map<number, number[]>();
  try {
    for (const d of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${d}/stat`, "utf8");
        const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        if (!kids.has(ppid)) kids.set(ppid, []);
        kids.get(ppid)!.push(Number(d));
      } catch { /* exited */ }
    }
  } catch { /* no /proc */ }
  const order: number[] = [];
  const walk = (p: number) => { for (const k of kids.get(p) || []) walk(k); order.push(p); };
  walk(pid);
  for (const p of order) { try { process.kill(p, sig); } catch { /* gone */ } }
  return order;
}

// ---------------------------------------------------------------- delivery
// The runner doesn't know where alerts go. It hands each message, on stdin,
// to the notify command: the executable at PI_ROUTINES_NOTIFY, or
// ~/.config/pi-agent/notify. Exit 0 means delivered. Whatever sends it —
// chat, push, mail — is the machine's config (Ansible), not this repo's.
// With no command, messages are logged and wait in the outbox.

const NOTIFY_TIMEOUT_MS = 30_000;
const notifyCmd = () => process.env.PI_ROUTINES_NOTIFY || path.join(HOME, ".config/pi-agent/notify");

let posting = 0;
/** Deliver one message; false if it didn't go out (no command, or it failed). */
export async function deliver(body: string): Promise<boolean> {
  const cmd = notifyCmd();
  try { fs.accessSync(cmd, fs.constants.X_OK); } catch {
    log(`notify: no notify command (${cmd}) — message only logged:`, body);
    return false;
  }
  body = body.length > BODY_MAX ? `${body.slice(0, BODY_MAX)}…` : body;
  posting++;
  try {
    return await new Promise<boolean>((resolve) => {
      let err = "";
      let done = false;
      const finish = (ok: boolean, why?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (!ok) log(`notify: ${why}${err.trim() ? `: ${err.trim().slice(0, 500)}` : ""} — message:`, body);
        resolve(ok);
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(cmd, [], { stdio: ["pipe", "ignore", "pipe"], env: { ...process.env, PI_ROUTINES_HOST: HOST } });
      } catch (e: any) { finish(false, e.message); return; }
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } finish(false, "timed out"); }, NOTIFY_TIMEOUT_MS);
      child.stderr!.on("data", (d) => { if (err.length < 2000) err += d; });
      child.on("error", (e) => finish(false, e.message));
      child.on("close", (code) => finish(code === 0, `exited with ${code}`));
      child.stdin!.on("error", () => { /* reported by close */ });
      child.stdin!.end(body);
    });
  } finally {
    posting--;
  }
}

// ---------------------------------------------------------------- outbox
// Messages that must not be lost (a failure, a recovery, a routine change)
// wait here until the notify command takes them, retried every tick. A failure counts as
// told (state.failing) only once its message went out.

type OutMsg = { id: string; text: string; routine?: string; kind?: string };
const outboxFile = () => path.join(process.env.PI_ROUTINES_STATE_DIR || path.join(HOME, ".local/state/pi-routines"), "outbox.json");
function readOutbox(): OutMsg[] { try { const o = JSON.parse(readRegular(outboxFile(), 1 << 20) || "[]"); return Array.isArray(o) ? o : []; } catch { return []; } }
/** Every outbox change is a synchronous read-modify-write of the file (atomic
 *  rename), so nothing written while a post is in flight is lost. */
function editOutbox(f: (o: OutMsg[]) => OutMsg[]) {
  fs.mkdirSync(path.dirname(outboxFile()), { recursive: true, mode: 0o700 });
  atomicWrite(outboxFile(), JSON.stringify(f(readOutbox()).slice(-50), null, 2) + "\n");
}
/** Drop a routine's pending fail/ok message that a newer run made stale. */
function dropPending(routine: string, kind: string) {
  if (readOutbox().some((m) => m.routine === routine && m.kind === kind)) editOutbox((o) => o.filter((m) => !(m.routine === routine && m.kind === kind)));
}
function enqueue(text: string, routine?: string, kind?: string) {
  editOutbox((o) => {
    // A failure still waiting to go out isn't queued twice.
    if (routine && o.some((m) => m.routine === routine && m.kind === kind)) return o;
    return [...o, { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text, routine, kind }];
  });
}
/** Set a routine's state fields from the current file (synchronous, so it
 *  never overwrites what another step just wrote). */
function patchState(name: string, patch: RoutineState) {
  writeState(name, { ...readState(name), ...patch });
}
let flushing = false;
export async function flushOutbox() {
  if (flushing) return;
  flushing = true;
  try {
    for (;;) {
      const next = readOutbox()[0];
      if (!next) break;
      if (!(await deliver(next.text))) break;
      // Remove it by id from the file as it is now, not from a stale copy.
      let still = false;
      editOutbox((o) => { still = o.some((m) => m.id === next.id); return o.filter((m) => m.id !== next.id); });
      // A failure counts as told only once it went out (and wasn't made stale meanwhile).
      if (still && next.routine && (next.kind === "fail" || next.kind === "ok")) patchState(next.routine, { failing: next.kind === "fail" });
    }
  } finally { flushing = false; }
}

/** Notes post at most POSTS_PER_HOUR times per routine per hour; the post
 *  that reaches the limit says so. */
export function rateLimited(state: RoutineState, text: string, now: number): { text?: string; posts: string[] } {
  const posts = (Array.isArray(state.posts) ? state.posts : []).filter((t) => now - Date.parse(t) < 3600_000);
  if (posts.length >= POSTS_PER_HOUR) return { posts };
  posts.push(new Date(now).toISOString());
  return { text: posts.length === POSTS_PER_HOUR ? `${text}\n(muted for the rest of the hour: ${POSTS_PER_HOUR} messages)` : text, posts };
}

// ---------------------------------------------------------------- runs

const running = new Map<string, number>();   // routine -> pid (0 while starting)
const queue: SignedRoutine[] = [];

export function run(r: SignedRoutine): Promise<void> {
  return new Promise((resolve) => {
    const prev = readState(r.name);
    const start = new Date();
    const cwd = r.cwd;
    const res: RunResult = { ok: false, summary: "", notes: [] };
    let stderr = "";
    let timedOut = false;
    let spawnError = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    running.set(r.name, 0);
    const finish = async (code: number | null) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      res.ok = !timedOut && !spawnError && code === 0 && !!res.summary && !res.lastError;
      res.error = spawnError ? `could not start pi: ${spawnError}`
        : timedOut ? `timed out after ${r.timeoutMin} min`
        : res.lastError ? res.lastError.slice(0, 300)
        : code !== 0 ? `pi exited with ${code}: ${stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300)}`
        : !res.summary ? "pi gave no answer" : undefined;
      // Only the fields a run owns; written onto the state as it is at that
      // moment (an outbox flush may have set `failing` meanwhile).
      let state: RoutineState = {
        lastStart: start.toISOString(), lastEnd: new Date().toISOString(), lastOk: res.ok,
        lastError: res.error, lastSummary: res.summary.slice(0, SUMMARY_CHARS), lastNotified: res.notes,
        runs: (prev.runs || 0) + 1, posts: readState(r.name).posts,
      };
      dropPending(r.name, res.ok ? "fail" : "ok");
      for (const m of alertsFor(r.name, prev, res)) {
        if (m.kind === "note") {
          const rl = rateLimited(state, m.text, Date.now());
          state = { ...state, posts: rl.posts };
          if (!rl.text) log(`run ${r.name}: notify muted (rate limit): ${m.text}`);
          else if (!(await deliver(rl.text))) log(`run ${r.name}: notify not delivered`);
        } else {
          enqueue(m.text, r.name, m.kind);
        }
      }
      try { patchState(r.name, state); } catch (e: any) { log(`run ${r.name}: state not saved: ${e.message}`); }
      log(`run ${r.name}: ${res.ok ? "done" : `failed: ${res.error}`}${res.notes.length ? `; notified: ${res.notes.join(" | ")}` : ""}`);
      await flushOutbox();
      running.delete(r.name);
      resolve();
      pump();
    };
    if (!fs.existsSync(cwd)) { spawnError = `start directory ${cwd} is gone`; void finish(null); return; }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(PI, ["--mode", "json", "-p", "--no-session", runPrompt(r, HOST, prev, start)], {
        cwd, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PI_ROUTINE: r.name, PI_ROUTINE_CWD: cwd, PI_ROUTINES_RUNNER_MAIN: "" },
      });
    } catch (e: any) { spawnError = e?.code || e?.message || String(e); void finish(null); return; }
    log(`run ${r.name}: start in ${cwd}`);
    child.on("error", (e: any) => { spawnError = e?.code || e?.message || String(e); void finish(null); });
    if (child.pid) running.set(r.name, child.pid);
    let buf = "";
    child.stdout!.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { foldEvent(res, buf.slice(0, i)); buf = buf.slice(i + 1); }
      if (buf.length > 1 << 20) buf = "";   // one absurd line: drop it rather than grow
    });
    child.stderr!.on("data", (d) => { stderr = (stderr + d.toString()).slice(-4000); });
    timer = setTimeout(() => {
      timedOut = true;
      if (!child.pid) return;
      const tree = killTree(child.pid, "SIGTERM");
      setTimeout(() => { for (const p of tree) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } } }, 5000).unref();
    }, r.timeoutMin * 60_000);
    child.on("close", (code) => {
      if (buf) foldEvent(res, buf);
      void finish(code);
    });
  });
}

function pump() {
  while (running.size < MAX_PARALLEL && queue.length) {
    const r = queue.shift()!;
    if (running.has(r.name)) continue;
    run(r).catch((e) => log(`run ${r.name}: ${e?.message || e}`));
  }
}

// ---------------------------------------------------------------- scheduling

function readKey(): string {
  return (readRegular(KEY_FILE) || "").trim();
}

/** Run-now requests: regular <name>.run files, removed as they are read.
 *  Anything else with that name (a directory, a FIFO, a link) is ignored. */
export function takeRequests(dir = routinesDir()): Set<string> {
  const out = new Set<string>();
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".run")).slice(0, 200); } catch { return out; }
  for (const f of files) {
    const p = path.join(dir, f);
    try {
      if (!fs.lstatSync(p).isFile()) continue;
      fs.unlinkSync(p);
      out.add(f.slice(0, -4));
    } catch { /* raced */ }
  }
  return out;
}

/** Which routines start at this tick. `prevTick` is the previous tick's time
 *  (undefined at startup): a wall minute a spring-forward jump skipped since
 *  then is caught up for hour-pinned jobs, and a wall minute that repeats
 *  when clocks fall back doesn't start them twice. */
export function dueRoutines(
  routines: SignedRoutine[], now: number, requested: Set<string>,
  states: Record<string, RoutineState>, prevTick?: number,
): { due: SignedRoutine[]; wall: Record<string, string> } {
  const due: SignedRoutine[] = [];
  const wall: Record<string, string> = {};
  for (const r of routines) {
    const st = states[r.name] || {};
    if (requested.has(r.name)) {
      const last = st.lastStart ? Date.parse(st.lastStart) : 0;
      if (!(now - last < RUN_NOW_GAP_MS)) { due.push(r); continue; }
    }
    let c;
    try { c = parseCron(r.cron); } catch { continue; }
    const w = wallClock(now, r.tz);
    const key = wallKey(w);
    const cands: Wall[] = [w];
    // Ticks a minute or two apart (not after downtime: nothing is made up).
    if (prevTick !== undefined && now - prevTick <= 150_000 && !everyHour(c)) {
      let p = nextWall(wallClock(prevTick, r.tz));
      for (let i = 0; i < 120 && wallKey(p) < key; i++, p = nextWall(p)) cands.push(p);
    }
    if (!cands.some((x) => matchesWall(c!, x))) continue;
    const [lastTz, lastKey] = String(st.lastWall || "").split("|");
    if (!everyHour(c) && lastTz === r.tz && lastKey && lastKey >= key) continue;
    due.push(r);
    wall[r.name] = `${r.tz}|${key}`;
  }
  return { due, wall };
}

let prevTick: number | undefined;
let lastIgnored = "";

/** Keep the ledger: record new and changed routines, tombstone deleted ones,
 *  and tell the owner about each change and anything refused. */
let lastRefusedPost = 0;
function reconcile(routines: SignedRoutine[], ignored: string[], ledger: Ledger, complete: boolean) {
  let changed = false;
  for (const r of routines) {
    const seen = ledger[r.name];
    if (!seen || seen.gone || seen.created !== r.created) {
      enqueue(`🗓️ ${HOST} · routine ${r.name} ${seen && !seen.gone ? "changed" : "added"}: "${r.cron}" (${r.tz}) in ${r.cwd}`);
      ledger[r.name] = { created: r.created };
      changed = true;
    }
  }
  const live = new Set(routines.map((r) => r.name));
  // Record deletions only when every file was read with the key: a missing
  // key or an unreadable folder must not tombstone routines for good.
  for (const [name, e] of complete ? Object.entries(ledger) : []) {
    if (!e.gone && !live.has(name)) {
      enqueue(`🗑️ ${HOST} · routine ${name} was deleted (or stopped being valid).`);
      ledger[name] = { ...e, gone: true };
      changed = true;
    }
  }
  if (changed) writeLedger(ledger);
  const ig = ignored.join("; ");
  if (ig !== lastIgnored) {
    if (ig) log(`ignored: ${ig}`);
    // At most one refusal notice an hour: planting junk each minute can't flood the room.
    if (ig && Date.now() - lastRefusedPost >= 3600_000) {
      enqueue(`🚫 ${HOST} · pi-routines refused ${ignored.length} file(s) in ~/.local/share/pi-routines: ${defuse(ig).slice(0, 1000)}`);
      lastRefusedPost = Date.now();
    }
    lastIgnored = ig;
  }
}

export function tick(now = Date.now()) {
  const ledger = readLedger();
  const { routines, ignored, complete } = loadRoutines(readKey(), routinesDir(), ledger);
  reconcile(routines, ignored, ledger, complete);
  const requested = takeRequests();
  const states: Record<string, RoutineState> = {};
  for (const r of routines) states[r.name] = readState(r.name);
  const { due, wall } = dueRoutines(routines, now, requested, states, prevTick);
  prevTick = now;
  for (const r of due) {
    if (running.has(r.name) || queue.some((q) => q.name === r.name)) { log(`run ${r.name}: skipped, previous run still going`); continue; }
    if (wall[r.name]) patchState(r.name, { lastWall: wall[r.name] });
    queue.push(r);
  }
  pump();
  void flushOutbox();
}

/** Test hook: wait until no run is going or queued. */
export async function idle() {
  while (running.size || queue.length || flushing || posting) await new Promise((r) => setTimeout(r, 20));
}
export const _internals = { readOutbox, resetTicks: () => { prevTick = undefined; lastIgnored = ""; lastRefusedPost = 0; } };

// ---------------------------------------------------------------- main

// The dotfiles timer updates this code in place but can't restart a system
// service, so the runner watches its own sources: once they change and no run
// or post is in flight, it exits and systemd (Restart=always) starts the new one.
const SOURCES = ["runner.ts", "../extensions/routines-core.ts", "../extensions/cron.ts"].map((f) => path.resolve(HERE, f));
const sourceStamp = () => SOURCES.map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join(",");

function schedule() {
  // A second into each minute, so the minute being checked is unambiguous.
  const now = Date.now();
  setTimeout(() => {
    try { tick(); } catch (e: any) { log("tick failed:", e?.message || e); }
    schedule();
  }, 60_000 - (now % 60_000) + 1000);
}

if (process.env.PI_ROUTINES_RUNNER_MAIN === "1") {
  const startStamp = sourceStamp();
  log(`pi-routines on ${HOST}: up to ${MAX_PARALLEL} runs at once, launcher ${PI}`);
  process.on("unhandledRejection", (e: any) => log("unhandled:", e?.stack || e));
  process.on("uncaughtException", (e: any) => log("uncaught:", e?.stack || e));
  const stop = () => {
    for (const pid of running.values()) if (pid) killTree(pid, "SIGTERM");
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  schedule();
  // Half a minute off the ticks, so a restart never swallows a due minute.
  setTimeout(() => setInterval(() => {
    if (!running.size && !queue.length && !posting && !flushing && sourceStamp() !== startStamp) { log("code updated; restarting"); process.exit(0); }
  }, 60_000), 60_000 - (Date.now() % 60_000) + 30_000);
}
