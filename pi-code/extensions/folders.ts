// Folder access from the chat (Claude Code's /add-dir). The sandbox's mounts
// are fixed when pi starts, so a folder can't be added to a running pi.
// Instead: pi asks with request_folder_access (or you type /add-dir <path>),
// you approve on screen, pi restarts into the same conversation with the
// folder writable, and carries on. Approved folders are remembered for the
// project (pi.sh keeps them in ~/.config/pi-agent/grants, hidden from the
// sandbox), so each is asked for once. /dirs lists them; /remove-dir drops one.
//
// The request pi.sh acts on is signed with a key only pi's process holds
// (fd 3, like memory and routines), and carries a one-time nonce for this
// launch: bash can't write a request pi.sh will accept, and the owner's yes
// on screen is the only way the model gets one written. pi.sh checks every
// folder again (grants.py) before it mounts anything.
//
// This also tells the model, each run, what it can write and how to ask for
// more, so it stops asking the owner to edit the launcher.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import type { Secrets } from "./secrets.ts";

const MSG = "homelab-folders";
const SYSTEM = ["/etc", "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/boot", "/proc", "/sys", "/dev",
  "/run", "/var", "/root", "/snap", "/opt", "/srv", "/tmp"];

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], details: {}, ...(isError ? { isError: true } : {}) });
const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

/** Why `real` (a resolved path) can't be granted, or "". Mirrors grants.py, which is authoritative. */
export function refusal(real: string, o: { home: string; project: string; codeDir: string }): string {
  if (real === "/") return "the whole filesystem can't be writable";
  if (inside(o.home, real)) return "home itself (or a folder above it) can't be writable: things there run outside the sandbox";
  if (real.startsWith(`${o.home}/`) && real.slice(o.home.length + 1).split("/")[0].startsWith(".")) {
    return "hidden folders in home (~/.config, ~/.local ...) hold things that run outside the sandbox";
  }
  if (o.codeDir && (inside(real, path.dirname(o.codeDir)) || inside(path.dirname(o.codeDir), real))) return "pi's own code can't be writable to pi";
  for (const s of SYSTEM) if (inside(real, s)) return `${s} is a system folder`;
  if (o.project && inside(real, o.project)) return "it's already writable (inside the project)";
  return "";
}

export function extraDirs(): string[] {
  return (process.env.PI_EXTRA_RW || "").split(":").filter(Boolean);
}

export function sandboxNote(project: string, extras: string[], canAsk: boolean): string {
  const rw = project && path.isAbsolute(project) ? [project, ...extras] : extras;
  return [
    "You run in a sandbox. Writable: " + (rw.length ? rw.join(", ") : "nothing in this session (a read-only session)") +
      ", and /tmp. Everywhere else is read-only: writes fail with \"Read-only file system\".",
    canAsk
      ? "If the task needs to write to another folder, call request_folder_access with that folder and why. The owner approves on screen, pi restarts into this same conversation with the folder writable, and you continue. Don't ask the owner to change the launcher or its bwrap mounts."
      : "This session can't ask for more folders (the owner can restart pi with PI_RW=<folder>).",
    "Every bash command is checked by a safety classifier. A blocked command can't be approved during the session: tell the owner what was blocked and why the task needs it, and look for another way meanwhile.",
  ].join(" ");
}

export default function registerFolders(pi: any, secrets: Secrets) {
  if (process.env.PI_ROUTINE) return;
  const key = secrets.grantKey;
  const req = process.env.PI_GRANT_REQUEST || "";
  const nonce = process.env.PI_GRANT_NONCE || "";
  const project = process.env.PI_PROJECT_DIR || "";
  const rwProject = path.isAbsolute(project);
  const home = (() => { try { return fs.realpathSync(os.homedir()); } catch { return os.homedir(); } })();
  const codeDir = process.env.PI_CODE_DIR || "";
  const canRequest = !!(key && req && nonce && rwProject && !process.env.PI_SUBAGENT);
  // Once a restart is on its way, nothing else runs: pi only shuts down when the
  // model stops, and a model that keeps going would hit the old mounts.
  let restarting = false;
  pi.on("tool_call", async () => restarting
    ? { block: true, reason: "pi is restarting with the new folder access; this conversation continues right after.", terminate: true }
    : undefined);

  // Every run: what's writable and how to get more.
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    const note = sandboxNote(project, extraDirs(), canRequest && !!ctx?.hasUI);
    const sections = event?.systemPromptOptions?.sections;
    if (sections && typeof sections === "object") sections.sandbox = note;
  });

  /** Resolve and check a folder; [real path, ""] or ["", why not]. */
  const resolve = (p: string): [string, string] => {
    const abs = path.resolve(project && rwProject ? project : process.cwd(), String(p || "").replace(/^~(?=\/|$)/, home));
    let real: string;
    try { real = fs.realpathSync(abs); } catch { return ["", `${abs} doesn't exist`]; }
    try { if (!fs.statSync(real).isDirectory()) return ["", `${real} is not a folder`]; } catch { return ["", `${real} can't be read`]; }
    if (extraDirs().some((d) => inside(real, d))) return ["", `${real} is already writable`];
    const why = refusal(real, { home, project: rwProject ? project : "", codeDir });
    return why ? ["", `${real}: ${why}`] : [real, ""];
  };

  const restartWith = (ctx: any, change: { add?: string[]; remove?: string[] }, by: "tool" | "user") => {
    const line = JSON.stringify({
      nonce, project, add: change.add || [], remove: change.remove || [], by,
      session: ctx.sessionManager?.getSessionFile?.() || "",
    });
    const sig = crypto.createHmac("sha256", key).update(`pi-grant\0${line}`).digest("hex");
    fs.writeFileSync(req, `${line}\n${sig}\n`, { mode: 0o600 });
    restarting = true;
    ctx.shutdown();
  };

  // After a restart for a grant: say so, and let the model pick the task back up.
  pi.on("session_start", async (event: any, ctx: any) => {
    const raw = process.env.PI_GRANT_RESUMED;
    if (!raw || event?.reason !== "startup") return;
    delete process.env.PI_GRANT_RESUMED;
    let r: any;
    try { r = JSON.parse(raw); } catch { return; }
    const added: string[] = r.added || [], removed: string[] = r.removed || [];
    if (ctx?.hasUI) ctx.ui.notify([added.length && `Writable now: ${added.join(", ")}`, removed.length && `No longer writable: ${removed.join(", ")}`].filter(Boolean).join(". "), "info");
    if (r.by === "tool" && added.length) {
      pi.sendMessage({ customType: MSG, display: true, content: `The owner approved write access to ${added.join(", ")}, and pi restarted with it. Continue the task where you left off.` }, { triggerTurn: true });
    } else if (added.length || removed.length) {
      pi.sendMessage({ customType: MSG, display: true, content: `Folder access changed by the owner. ${sandboxNote(project, extraDirs(), canRequest)}` });
    }
  });

  pi.registerTool({
    name: "request_folder_access",
    label: "Ask for folder access",
    description:
      "Ask the owner to make a folder outside the project writable. On a yes, pi restarts into this same conversation " +
      "with the folder writable (remembered for this project), and you continue. Use it when the task needs to write there; " +
      "reading works everywhere already.",
    promptSnippet: "Ask the owner for write access to a folder outside the project",
    parameters: Type.Object({
      path: Type.String({ description: "The folder (absolute, or relative to the project)" }),
      reason: Type.String({ description: "One sentence: what you need to write there and why" }),
    }),
    async execute(_id: string, p: any, _signal: any, _onUpdate: any, ctx: any) {
      if (!canRequest || !ctx?.hasUI) {
        return text("This session can't ask for folders (no one to approve, or not a project session). Tell the owner which folder you need; they can start pi with PI_RW=<folder>.", true);
      }
      const [real, why] = resolve(p.path);
      if (!real) return text(`Not requested: ${why}.`, true);
      const ok = await ctx.ui.confirm(`Let pi write to ${real}?`, [
        `Why: ${String(p.reason || "(no reason given)").trim().slice(0, 500)}`,
        ...(real.startsWith("/mnt/") ? ["", "⚠ This is on the storage array (tank)."] : []),
        "",
        "pi restarts and continues this conversation with the folder writable.",
        "Remembered for this project: /dirs lists folders, /remove-dir takes one away.",
      ].join("\n"));
      if (!ok) return text(`The owner declined write access to ${real}. Don't ask again for it in this session; find another way or ask what they'd prefer.`, true);
      restartWith(ctx, { add: [real] }, "tool");
      // terminate: no follow-up model call, so pi goes idle and restarts at once.
      return { ...text(`Approved. pi is restarting with ${real} writable and will continue this conversation by itself.`), terminate: true };
    },
  });

  pi.registerCommand("add-dir", {
    description: "Make a folder writable for this project (pi restarts into this conversation)",
    handler: async (args: string, ctx: any) => {
      if (!canRequest) { ctx.ui.notify("This session can't add folders (not a project session). Start pi with PI_RW=<folder> instead.", "warning"); return; }
      const want = args.trim();
      if (!want) { ctx.ui.notify("Usage: /add-dir <folder>", "warning"); return; }
      const [real, why] = resolve(want);
      if (!real) { ctx.ui.notify(`Not added: ${why}.`, "warning"); return; }
      ctx.ui.notify(`Restarting with ${real} writable…`, "info");
      restartWith(ctx, { add: [real] }, "user");
    },
  });

  pi.registerCommand("remove-dir", {
    description: "Stop a folder you added being writable (pi restarts into this conversation)",
    handler: async (args: string, ctx: any) => {
      if (!canRequest) { ctx.ui.notify("Folders can't be changed in this session.", "warning"); return; }
      const want = args.trim();
      let real = want;
      try { real = fs.realpathSync(path.resolve(project, want.replace(/^~(?=\/|$)/, home))); } catch { /* compare as given */ }
      if (!extraDirs().includes(real)) { ctx.ui.notify(`${real} isn't one of the added folders. /dirs lists them.`, "warning"); return; }
      ctx.ui.notify(`Restarting without ${real}…`, "info");
      restartWith(ctx, { remove: [real] }, "user");
    },
  });

  pi.registerCommand("dirs", {
    description: "List the folders pi can write to",
    handler: async (_args: string, ctx: any) => {
      const extras = extraDirs();
      ctx.ui.notify([
        `Project: ${rwProject ? project : "none (read-only session)"}`,
        extras.length ? `Added: ${extras.join(", ")}` : "Added: none (/add-dir <folder>, or pi asks when it needs one)",
        "Also /tmp. Everything else is read-only.",
      ].join("\n"), "info");
    },
  });
}
