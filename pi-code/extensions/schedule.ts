// In-session scheduling, like Claude Code's: pi can put a prompt on a cron
// schedule (cron_create) or wake itself up after a delay (schedule_wakeup),
// when asked in plain words ("check the VPN every 5 minutes"). No command
// needed. Rules match Claude Code's:
//   - session-only: jobs live in this pi process (they survive /reload, not
//     quitting, /new or /resume); use a routine for anything that must outlast it
//   - a job fires only while pi is idle, as a new message in this session
//   - recurring jobs run a fixed per-job delay late (up to half their period,
//     max 30 min) so many jobs don't land at once, and expire after 7 days
//     (they fire one final time, then are deleted)
//   - schedule_wakeup: 60 s to 1 h, one pending wake-up at a time
// Interactive sessions only: in print mode nothing would be left to fire.

import { createHash, randomBytes } from "node:crypto";
import { Type } from "typebox";
import { describeNext, nextRun, parseCron, wallClock } from "./cron.ts";
import { defaultTimeZone } from "./routines-core.ts";

const MAX_JOBS = 20;
const TICK_MS = 5_000;
const WEEK_MS = 7 * 24 * 3600_000;
const MAX_LATE_MS = 30 * 60_000;
const EARLY_MS = 90_000;

type Job = {
  id: string;
  kind: "cron" | "wakeup";
  cron?: string;
  tz: string;
  prompt: string;
  reason?: string;
  recurring: boolean;
  created: number;
  expires?: number;   // recurring: after this, the next fire is the last
  due: number;        // next fire, offset included
};

type State = { jobs: Map<string, Job>; timer?: ReturnType<typeof setInterval>; ctx?: any };
const STASH = Symbol.for("homelab.pi.schedule");
const g = globalThis as any;
const state: State = (g[STASH] ??= { jobs: new Map() });

/** A fraction in [0,1) fixed per job, so its offset doesn't drift between fires. */
function frac(id: string): number {
  return createHash("sha256").update(id).digest().readUInt32BE(0) / 2 ** 32;
}

/** When a cron job next fires after `after`, with its per-job offset. */
export function nextDue(id: string, cronText: string, tz: string, recurring: boolean, after: number): number | undefined {
  const c = parseCron(cronText);
  const t1 = nextRun(c, after, tz);
  if (t1 === undefined) return undefined;
  if (recurring) {
    const t2 = nextRun(c, t1, tz);
    const period = t2 === undefined ? 0 : t2 - t1;
    return t1 + Math.floor(frac(id) * Math.min(period / 2, MAX_LATE_MS));
  }
  // A one-shot landing on :00 or :30 goes up to 90 s early (everyone picks those).
  const m = wallClock(t1, tz).minute;
  return m === 0 || m === 30 ? Math.max(after + 1000, t1 - Math.floor(frac(id) * EARLY_MS)) : t1;
}

function fmt(t: number, tz: string) { return describeNext(t, tz); }

function listText(): string {
  if (!state.jobs.size) return "No scheduled jobs in this session.";
  return [...state.jobs.values()].sort((a, b) => a.due - b.due).map((j) =>
    `${j.id}  ${j.kind === "cron" ? `cron "${j.cron}"${j.recurring ? "" : " (once)"}` : "wake-up"}  next: ${fmt(j.due, j.tz)}` +
    `${j.expires ? `  expires: ${fmt(j.expires, j.tz)}` : ""}\n    ${j.prompt.replace(/\s+/g, " ").slice(0, 160)}`,
  ).join("\n");
}

function setStatus() {
  const ctx = state.ctx;
  if (!ctx?.hasUI) return;
  try {
    if (!state.jobs.size) { ctx.ui.setStatus("schedule", undefined); return; }
    const next = Math.min(...[...state.jobs.values()].map((j) => j.due));
    const when = new Date(next).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: defaultTimeZone() });
    ctx.ui.setStatus("schedule", `⏰ ${state.jobs.size} scheduled · next ${when}`);
  } catch { /* UI gone */ }
}

export function tick(pi: any) {
  const ctx = state.ctx;
  if (!ctx || !state.jobs.size) return;
  let idle = false;
  try { idle = ctx.isIdle() && !ctx.hasPendingMessages(); } catch { return; }
  if (!idle) return;
  const now = Date.now();
  const due = [...state.jobs.values()].filter((j) => j.due <= now).sort((a, b) => a.due - b.due)[0];
  if (!due) return;
  // One per tick: the message starts a run, and the next job waits for idle again.
  let last = false;
  if (due.kind === "cron" && due.recurring) {
    if (due.expires !== undefined && now >= due.expires) last = true;
    const n = last ? undefined : nextDue(due.id, due.cron!, due.tz, true, now);
    if (n === undefined) state.jobs.delete(due.id); else due.due = n;
  } else {
    state.jobs.delete(due.id);
  }
  const head = due.kind === "wakeup"
    ? `[Scheduled wake-up ${due.id}${due.reason ? `: ${due.reason}` : ""}]`
    : `[Scheduled job ${due.id}, cron "${due.cron}"${last ? " — final run: recurring jobs expire after 7 days; schedule it again if still needed" : ""}]`;
  try { pi.sendUserMessage(`${head}\n${due.prompt}`); } catch { /* session gone */ }
  setStatus();
}

function ensureTimer(pi: any) {
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(() => tick(pi), TICK_MS);
  state.timer.unref?.();
}

function stop() {
  if (state.timer) clearInterval(state.timer);
  state.timer = undefined;
  state.jobs.clear();
}

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], details: {}, ...(isError ? { isError: true } : {}) });
const NO_UI = "Scheduling only works in an interactive pi session (this one exits when its prompt is done, so nothing would fire). " +
  "For something that must run on its own, use routine_create.";

export default function registerSchedule(pi: any) {
  const remember = (_e: any, ctx: any) => { state.ctx = ctx; };
  pi.on("session_start", (e: any, ctx: any) => { state.ctx = ctx; ensureTimer(pi); setStatus(); });
  pi.on("before_agent_start", remember);
  pi.on("agent_end", remember);
  pi.on("session_shutdown", (e: any) => {
    // /reload keeps the jobs (the new module instance picks them up);
    // quitting, /new, /resume and fork end them, as a session's jobs should.
    if (e?.reason === "reload") { if (state.timer) clearInterval(state.timer); state.timer = undefined; return; }
    stop();
    try { state.ctx?.ui?.setStatus("schedule", undefined); } catch { /* ignore */ }
  });

  pi.registerTool({
    name: "cron_create",
    label: "Schedule",
    description:
      "Schedule a prompt to run in THIS session on a cron schedule: recurring (\"every 5 minutes\", \"weekdays at 9\") " +
      "or once (\"at 2:30 pm, check the deploy\"). Standard 5-field cron (minute hour day-of-month month day-of-week), " +
      `read in the owner's time zone (${defaultTimeZone()}). The prompt is sent as a new message when the time comes, ` +
      "only while the session is idle. Recurring jobs run up to half their period late (max 30 min) and expire after " +
      "7 days. Jobs end when this session ends; for something that must keep running on its own, use routine_create.",
    promptSnippet: "Schedule a prompt in this session (cron, recurring or once)",
    promptGuidelines: [
      "Use cron_create when the user asks to check or do something repeatedly or at a time during this session.",
      "Avoid minute 0 and 30 unless the user names that exact time: for 'hourly' use e.g. '7 * * * *', for 'around 9' '57 8 * * *'.",
      "For a one-shot, pin minute, hour, day and month and set recurring: false.",
      "Tell the user the next run time cron_create returns, and about the 7-day limit for recurring jobs.",
    ],
    parameters: Type.Object({
      cron: Type.String({ description: "5-field cron in the owner's time zone, e.g. '*/5 * * * *'" }),
      prompt: Type.String({ description: "The prompt to run each time, standing on its own" }),
      recurring: Type.Optional(Type.Boolean({ description: "true (default): repeat until deleted or expired; false: once" })),
    }),
    async execute(_id: string, p: any, _signal: any, _onUpdate: any, ctx: any) {
      state.ctx = ctx;
      if (!ctx?.hasUI) return text(NO_UI, true);
      if (state.jobs.size >= MAX_JOBS) return text(`Already ${MAX_JOBS} jobs scheduled; delete some first (cron_list, cron_delete).`, true);
      const prompt = String(p.prompt || "").trim();
      if (!prompt) return text("prompt is empty", true);
      const recurring = p.recurring !== false;
      const tz = defaultTimeZone();
      const id = randomBytes(4).toString("hex");
      let due: number | undefined;
      try { due = nextDue(id, String(p.cron), tz, recurring, Date.now()); } catch (e: any) { return text(`Bad cron: ${e.message}`, true); }
      if (due === undefined) return text("That cron expression never fires.", true);
      const now = Date.now();
      state.jobs.set(id, { id, kind: "cron", cron: parseCron(String(p.cron)).source, tz, prompt, recurring, created: now, expires: recurring ? now + WEEK_MS : undefined, due });
      ensureTimer(pi);
      setStatus();
      return text(`Scheduled job ${id}. Next run: ${fmt(due, tz)}.` +
        (recurring ? ` It repeats until deleted, and expires ${fmt(now + WEEK_MS, tz)}.` : " It runs once.") +
        " It runs only while this session is open and idle.");
    },
  });

  pi.registerTool({
    name: "schedule_wakeup",
    label: "Wake up",
    description:
      "Wake yourself up in this session after a delay (60-3600 s) with a prompt, to check back on something " +
      "without the user asking: a build, a download, a service you just restarted. Pick the delay from how fast the " +
      "thing changes. One pending wake-up at a time: a new one replaces the old. Session-only, idle-only.",
    promptSnippet: "Check back on something yourself after a delay",
    promptGuidelines: [
      "Use schedule_wakeup to check back on something slow you started or are watching, instead of waiting or asking the user to remind you.",
      "Keep checking back (another schedule_wakeup) until the thing is done or clearly stuck, then report.",
    ],
    parameters: Type.Object({
      delaySeconds: Type.Number({ description: "Seconds from now, 60-3600" }),
      prompt: Type.String({ description: "What to do when you wake up, standing on its own" }),
      reason: Type.String({ description: "One short line: what you are waiting for" }),
    }),
    async execute(_id: string, p: any, _signal: any, _onUpdate: any, ctx: any) {
      state.ctx = ctx;
      if (!ctx?.hasUI) return text(NO_UI, true);
      const prompt = String(p.prompt || "").trim();
      if (!prompt) return text("prompt is empty", true);
      const delay = Math.round(Math.min(3600, Math.max(60, Number(p.delaySeconds) || 60)));
      let replaced = "";
      for (const j of state.jobs.values()) if (j.kind === "wakeup") { state.jobs.delete(j.id); replaced = ` (replaced wake-up ${j.id})`; }
      if (state.jobs.size >= MAX_JOBS) return text(`Already ${MAX_JOBS} jobs scheduled; delete some first.`, true);
      const id = randomBytes(4).toString("hex");
      const tz = defaultTimeZone();
      const due = Date.now() + delay * 1000;
      state.jobs.set(id, { id, kind: "wakeup", tz, prompt, reason: String(p.reason || "").slice(0, 200), recurring: false, created: Date.now(), due });
      ensureTimer(pi);
      setStatus();
      return text(`Wake-up ${id} set for ${fmt(due, tz)} (in ${delay} s)${replaced}.`);
    },
  });

  pi.registerTool({
    name: "cron_list",
    label: "Scheduled jobs",
    description: "List this session's scheduled jobs and wake-ups with their next run times.",
    parameters: Type.Object({}),
    async execute() { return text(listText()); },
  });

  pi.registerTool({
    name: "cron_delete",
    label: "Unschedule",
    description: "Delete a scheduled job or wake-up of this session by its id (from cron_list).",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id: string, p: any) {
      const ok = state.jobs.delete(String(p.id));
      setStatus();
      return ok ? text(`Deleted ${p.id}.`) : text(`No job ${p.id}. ${listText()}`, true);
    },
  });

  pi.registerCommand("scheduled", {
    description: "List this session's scheduled jobs; '/scheduled clear' deletes them all",
    handler: async (args: string, ctx: any) => {
      state.ctx = ctx;
      if (args.trim() === "clear") { const n = state.jobs.size; state.jobs.clear(); setStatus(); ctx.ui.notify(`Deleted ${n} scheduled job(s).`, "info"); return; }
      ctx.ui.notify(listText(), "info");
    },
  });
}
