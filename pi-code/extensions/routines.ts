// Routines: pi runs that fire on a schedule with nobody watching, and keep
// doing so across pi restarts and reboots (Claude Code's routines, locally).
// Ask in plain words — "check every 10 minutes that the downloads VPN is up" —
// and pi proposes a routine; you approve it on screen; the pi-routines
// service on this VM (Ansible) runs it from then on, each run a fresh,
// sandboxed, classifier-gated pi. A run reports through the notify tool, and
// the service hands that to the machine's notify command (whatever channel
// the owner set up); silence means all is as expected.
//
// A routine runs unattended, forever, so creating or changing one needs the
// human: only an interactive session can, after an on-screen yes. Subagents,
// print-mode runs and routine runs themselves cannot. Files are signed
// (routines-core.ts), so one planted by bash is ignored.
//
// The machine's config can also set routines (root-owned files in
// /etc/pi-routines, from Ansible): they run the same way and are listed here,
// but are changed only through that config.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { describeNext, nextRun, parseCron } from "./cron.ts";
import {
  MAX_ROUTINES, TIMEOUT_DEFAULT_MIN, TIMEOUT_MAX_MIN, defaultTimeZone, deleteRoutine, loadAllRoutines,
  readState, routinesDir, saveRoutine, validate, type Routine,
} from "./routines-core.ts";
import type { Secrets } from "./secrets.ts";

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], details: {}, ...(isError ? { isError: true } : {}) });

/** Why this session may not create, change or delete routines, or "" if it may. */
function cannotManage(ctx: any): string {
  if (process.env.PI_ROUTINE) return "A routine run cannot create, change or delete routines.";
  if (process.env.PI_SUBAGENT) return "A subagent cannot manage routines.";
  if (!ctx?.hasUI) return "Routines can only be created or changed in an interactive pi session, where the owner approves them.";
  return "";
}

function nextText(r: Routine): string {
  try { return describeNext(nextRun(parseCron(r.cron), Date.now(), r.tz), r.tz); } catch { return "?"; }
}

function listText(key: string): string {
  const { routines, ignored } = loadAllRoutines(key);
  const lines: string[] = [];
  if (!routines.length) lines.push("No routines on this VM.");
  for (const r of routines) {
    const s = readState(r.name);
    const last = s.lastEnd
      ? `last run ${s.lastEnd}: ${s.lastOk ? (s.lastNotified?.length ? `reported "${s.lastNotified.join(" | ").slice(0, 200)}"` : "all as expected") : `failed (${s.lastError})`}`
      : "not run yet";
    lines.push(`${r.name}${r.managed ? " [machine config]" : ""}  "${r.cron}" (${r.tz})  next: ${nextText(r)}\n    in ${r.cwd}, timeout ${r.timeoutMin} min; ${last}\n    ${r.prompt.replace(/\s+/g, " ").slice(0, 200)}`);
  }
  if (ignored.length) lines.push(`Ignored (never run): ${ignored.join("; ")}`);
  return lines.join("\n");
}

export default function registerRoutines(pi: any, secrets: Secrets) {
  const key = secrets.routineKey;

  // Inside a routine run: the way to tell the owner something. The runner
  // reads these calls from the run's event stream and posts them.
  if (process.env.PI_ROUTINE) {
    pi.registerTool({
      name: "notify",
      label: "Notify owner",
      description:
        "Send the owner a short message (it reaches their phone). Use it only when something needs their attention: " +
        "newly broken, recovered, or the check could not be done. Not for 'all fine'.",
      promptSnippet: "Notify the owner when something needs their attention",
      parameters: Type.Object({ message: Type.String({ description: "Under 300 characters: what, where, what you did" }) }),
      async execute(_id: string, p: any) {
        const m = String(p.message || "").trim();
        if (!m) return text("message is empty", true);
        return text("Sent to the owner.");
      },
    });
    return;
  }
  if (process.env.PI_SUBAGENT) return;

  pi.registerTool({
    name: "routine_create",
    label: "Create routine",
    description:
      "Create or replace a routine: a pi run that fires on a cron schedule on this VM with nobody watching, and keeps " +
      "running across pi restarts and reboots (unlike cron_create, which lives only in this session). Each run is a " +
      "fresh pi in the sandbox with the usual classifier; it may fix what it finds, and it tells the owner only " +
      "when something needs attention. The owner must approve it on screen. Cron is 5-field, read in " +
      `${defaultTimeZone()}.`,
    promptSnippet: "Create a scheduled routine that runs unattended and survives restarts",
    promptGuidelines: [
      "Use routine_create when the user wants something checked or done on a schedule from now on, not just during this session.",
      "Write the routine's prompt so it stands on its own: exactly what to check, how to tell healthy from broken, and what (if anything) to fix.",
      "Avoid minute 0 and 30 unless the user names that exact time; spread schedules out (e.g. '*/10' -> '3-59/10').",
      "The tool asks the owner to approve; don't ask them separately first.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Short id: lowercase letters, digits, dashes (e.g. vpn-check)" }),
      cron: Type.String({ description: "5-field cron, e.g. '3-59/10 * * * *' for every 10 minutes" }),
      prompt: Type.String({ description: "What each run does, standing on its own" }),
      cwd: Type.Optional(Type.String({ description: "Absolute directory the run starts in (default: this session's). Only a project directory is writable to the run." })),
      timeoutMinutes: Type.Optional(Type.Number({ description: `Stop a run after this many minutes (default ${TIMEOUT_DEFAULT_MIN}, max ${TIMEOUT_MAX_MIN})` })),
    }),
    async execute(_id: string, p: any, _signal: any, _onUpdate: any, ctx: any) {
      const why = cannotManage(ctx);
      if (why) return text(why, true);
      if (!key) return text("No routine signing key: start pi through the pi launcher.", true);
      const r: Routine = {
        name: String(p.name || "").trim(),
        cron: String(p.cron || "").trim().split(/\s+/).join(" "),
        tz: defaultTimeZone(),
        prompt: String(p.prompt || "").trim(),
        cwd: "",
        timeoutMin: Math.round(Number(p.timeoutMinutes) || TIMEOUT_DEFAULT_MIN),
        created: new Date().toISOString(),
      };
      // The directory as it resolves now (links followed): the run is held to
      // exactly this path, and pi.sh refuses to start one anywhere else.
      try { r.cwd = fs.realpathSync(path.resolve(String(p.cwd || process.cwd()))); } catch { return text(`cwd does not exist: ${p.cwd || process.cwd()}`, true); }
      if (!fs.statSync(r.cwd).isDirectory()) return text(`cwd is not a directory: ${r.cwd}`, true);
      const errs = validate(r, true);
      if (errs.length) return text(`Invalid routine: ${errs.join("; ")}`, true);
      const all = loadAllRoutines(key).routines;
      if (all.some((x) => x.name === r.name && x.managed)) return text(`"${r.name}" is set by this machine's config (Ansible); change it there, or pick another name.`, true);
      const existing = all.filter((x) => !x.managed);
      const replacing = existing.some((x) => x.name === r.name);
      if (!replacing && existing.length >= MAX_ROUTINES) return text(`This VM already has ${MAX_ROUTINES} routines; delete one first.`, true);
      const ok = await ctx.ui.confirm(
        `${replacing ? "Replace" : "Create"} routine "${r.name}" on ${os.hostname()}?`,
        [
          `Runs: "${r.cron}" (${r.tz}) — next ${nextText(r)}`,
          `In: ${r.cwd}   Timeout: ${r.timeoutMin} min`,
          "Unattended, until deleted: a fresh sandboxed pi each run, bash gated by the classifier; it may change things to fix them.",
          "",
          `Prompt (${r.prompt.length} characters):`,
          // Runs of blank lines collapsed, so nothing hides below the fold.
          r.prompt.replace(/\n\s*\n(\s*\n)+/g, "\n\n"),
        ].join("\n"),
      );
      if (!ok) return text("The owner declined. The routine was not saved; ask what they'd like changed.", true);
      try { saveRoutine(r, key); } catch (e: any) { return text(`Could not save: ${e.message}`, true); }
      return text(`Routine "${r.name}" ${replacing ? "replaced" : "created"}. Next run: ${nextText(r)}. ` +
        "The pi-routines service on this VM runs it; results that need attention are sent to the owner. " +
        `Tell the owner: within a minute they get "routine ${r.name} ${replacing ? "changed" : "added"}" — ` +
        "that confirms the service took this version; if it doesn't appear, something else replaced it. " +
        "routine_list shows its last result.");
    },
  });

  pi.registerTool({
    name: "routine_list",
    label: "Routines",
    description: "List this VM's routines: schedule, next run, and what the last run found.",
    parameters: Type.Object({}),
    async execute() { return text(listText(key)); },
  });

  pi.registerTool({
    name: "routine_delete",
    label: "Delete routine",
    description: "Delete a routine by name, when the owner asks to stop it. The owner confirms on screen.",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id: string, p: any, _signal: any, _onUpdate: any, ctx: any) {
      const why = cannotManage(ctx);
      if (why) return text(why, true);
      const name = String(p.name);
      const found = loadAllRoutines(key).routines.find((r) => r.name === name);
      if (!found) return text(`No routine "${name}".\n${listText(key)}`, true);
      if (found.managed) return text(`"${name}" is set by this machine's config (Ansible); it can only be removed there.`, true);
      if (!(await ctx.ui.confirm(`Delete routine "${name}" on ${os.hostname()}?`, "It stops running; you can create it again later."))) {
        return text("The owner declined; the routine stays.", true);
      }
      return deleteRoutine(name) ? text(`Deleted routine "${name}".`) : text(`Could not delete "${name}".`, true);
    },
  });

  pi.registerTool({
    name: "routine_run",
    label: "Run routine now",
    description: "Ask the pi-routines service to run a routine now, outside its schedule (to test it). It starts within a minute.",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id: string, p: any, _signal: any, _onUpdate: any, ctx: any) {
      const why = cannotManage(ctx);
      if (why) return text(why, true);
      const name = String(p.name);
      if (!loadAllRoutines(key).routines.some((r) => r.name === name)) return text(`No routine "${name}".`, true);
      fs.writeFileSync(path.join(routinesDir(), `${name}.run`), new Date().toISOString() + "\n");
      return text(`Queued "${name}" to run within a minute. Check routine_list afterwards for its result.`);
    },
  });

  pi.registerCommand("routines", {
    description: "List routines; '/routines delete <name>' or '/routines run <name>'",
    handler: async (args: string, ctx: any) => {
      const [verb, name] = args.trim().split(/\s+/);
      if (verb === "delete" && name) {
        if (loadAllRoutines(key).routines.some((r) => r.name === name && r.managed)) { ctx.ui.notify(`"${name}" is set by this machine's config (Ansible); remove it there.`, "warning"); return; }
        ctx.ui.notify(deleteRoutine(name) ? `Deleted routine "${name}".` : `No routine "${name}".`, "info");
        return;
      }
      if (verb === "run" && name) {
        if (!loadAllRoutines(key).routines.some((r) => r.name === name)) { ctx.ui.notify(`No routine "${name}".`, "warning"); return; }
        fs.writeFileSync(path.join(routinesDir(), `${name}.run`), new Date().toISOString() + "\n");
        ctx.ui.notify(`Queued "${name}"; it starts within a minute.`, "info");
        return;
      }
      ctx.ui.notify(listText(key), "info");
    },
  });
}
