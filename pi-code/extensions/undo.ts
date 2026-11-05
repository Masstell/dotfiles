// Undo: before each prompt you send, the project's files are snapshotted;
// /undo puts them back as they were before any earlier prompt (Claude Code's
// rewind, for files). It catches every change in the project, whether made by
// edit, write, bash or a subagent, and works in folders that aren't git repos.
// Files your .gitignore lists are left alone, and so is the conversation
// (/tree rewinds that).
//
// Snapshots live in a separate git store per project (pi.sh: PI_UNDO_DIR,
// ~/.local/state/pi-undo/<project>), never in the project's own .git. The
// sandboxed agent can write that store too, so every git call here ignores
// its config and hooks: a planted core.fsmonitor or hook can't run code
// outside the classifier. Restoring only ever writes inside the project,
// which the agent could change directly anyway.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ENTRY = "homelab-undo";
const MAX_FILES = 20_000;           // bigger projects aren't snapshotted
const MAX_BYTES = 500 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const KEEP = 50;                    // checkpoints listed per session
const CONFIG = "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n";

export type Checkpoint = { commit: string; prompt: string; time: string };

export class Store {
  constructor(readonly gitDir: string, readonly workTree: string) {}

  git(args: string[], input?: string): { ok: boolean; out: string; err: string } {
    // No GIT_* from the session (GIT_DIR, GIT_INDEX_FILE ...) reaches this git.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
      GIT_AUTHOR_NAME: "pi undo", GIT_AUTHOR_EMAIL: "undo@pi", GIT_COMMITTER_NAME: "pi undo", GIT_COMMITTER_EMAIL: "undo@pi",
    });
    const r = spawnSync("git", [
      "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.autocrlf=false",
      "-c", "core.symlinks=true", "-c", "gc.auto=0", "-c", "advice.addEmbeddedRepo=false",
      "--git-dir", this.gitDir, "--work-tree", this.workTree, ...args,
    ], { env, input, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, cwd: this.workTree });
    return { ok: r.status === 0, out: r.stdout || "", err: (r.stderr || r.error?.message || "").trim() };
  }

  /** Create the store if needed and reset its config to ours (it may have been tampered with). */
  prepare() {
    fs.mkdirSync(path.dirname(this.gitDir), { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(this.gitDir, { throwIfNoEntry: false });
    if (st && !st.isDirectory()) throw new Error(`${this.gitDir} is not a folder`);
    if (!st) {
      const r = spawnSync("git", ["init", "-q", "--bare", this.gitDir], { encoding: "utf8", env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: process.env.HOME || "/", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
      if (r.status !== 0) throw new Error(`git init failed: ${(r.stderr || "").trim()}`);
    }
    fs.writeFileSync(path.join(this.gitDir, "config"), CONFIG);
    for (const f of ["info/attributes"]) fs.rmSync(path.join(this.gitDir, f), { force: true });
  }

  /** Files that would be snapshotted, and their total size; undefined if git can't list them. */
  size(): { files: number; bytes: number } | undefined {
    const r = this.git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    if (!r.ok) return undefined;
    const files = r.out.split("\0").filter(Boolean);
    let bytes = 0;
    for (const f of files.slice(0, MAX_FILES + 1)) { try { bytes += fs.lstatSync(path.join(this.workTree, f)).size; } catch { /* gone */ } }
    return { files: files.length, bytes };
  }

  /** Snapshot the work tree; the new commit. */
  snapshot(message: string): string {
    this.prepare();
    let r = this.git(["add", "-A", "--", "."]);
    if (!r.ok) throw new Error(`snapshot failed: ${r.err}`);
    r = this.git(["write-tree"]);
    if (!r.ok) throw new Error(`snapshot failed: ${r.err}`);
    const tree = r.out.trim();
    const parent = this.git(["rev-parse", "-q", "--verify", "refs/heads/undo"]);
    r = this.git(["commit-tree", tree, ...(parent.ok ? ["-p", parent.out.trim()] : []), "-m", message.slice(0, 500) || "snapshot"]);
    if (!r.ok) throw new Error(`snapshot failed: ${r.err}`);
    const commit = r.out.trim();
    this.git(["update-ref", "refs/heads/undo", commit]);
    return commit;
  }

  /** What restoring `target` would change, as "M path" lines, compared with commit `now`. */
  changes(now: string, target: string): string[] {
    const r = this.git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-status", now, target]);
    return r.ok ? r.out.split("\n").filter(Boolean).map((l) => l.replace(/\t/, " ")) : [];
  }

  /** Make the work tree match `target` (the index must hold the current snapshot). */
  restore(target: string) {
    this.prepare();
    const r = this.git(["read-tree", "-u", "--reset", target]);
    if (!r.ok) throw new Error(`restore failed: ${r.err}`);
  }
}

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 90 ? `${Math.round(s)}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};
const oneLine = (t: string, n = 70) => { const s = t.replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

export default function registerUndo(pi: any) {
  const project = process.env.PI_PROJECT_DIR || "";
  const dir = process.env.PI_UNDO_DIR || "";
  // Only a writable project session has anything to undo; workers and routine
  // runs are covered by the session that started them, or by nobody.
  if (!path.isAbsolute(project) || !path.isAbsolute(dir) || process.env.PI_SUBAGENT || process.env.PI_ROUTINE) return;
  const store = new Store(path.join(dir, "store.git"), project);
  let checkpoints: Checkpoint[] = [];
  let off = "";   // why undo is off for this session

  pi.on("session_start", async (_e: any, ctx: any) => {
    checkpoints = [];
    try {
      for (const e of ctx.sessionManager.getEntries()) {
        if (e?.type === "custom" && e.customType === ENTRY && e.data?.commit) checkpoints.push(e.data);
      }
    } catch { /* new session */ }
    checkpoints = checkpoints.slice(-KEEP);
    off = "";
    try {
      store.prepare();
      const s = store.size();
      if (!s) off = "the project's files couldn't be listed";
      else if (s.files > MAX_FILES || s.bytes > MAX_BYTES) off = `the project is too big to snapshot (${s.files} files, ${Math.round(s.bytes / 1048576)} MB)`;
    } catch (e: any) { off = e.message; }
    if (off && ctx.hasUI) ctx.ui.notify(`Undo is off: ${off}.`, "warning");
  });

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    if (off || event?.messageType !== "user" || !ctx?.hasUI) return;
    try {
      const cp: Checkpoint = { commit: store.snapshot(String(event.prompt || "")), prompt: String(event.prompt || ""), time: new Date().toISOString() };
      checkpoints = [...checkpoints, cp].slice(-KEEP);
      pi.appendEntry(ENTRY, cp);
    } catch (e: any) {
      if (ctx?.hasUI) ctx.ui.notify(`Undo: no snapshot this time (${e.message}).`, "warning");
    }
  });

  pi.registerCommand("undo", {
    description: "Put the project's files back as they were before one of your earlier prompts",
    handler: async (_args: string, ctx: any) => {
      if (off) { ctx.ui.notify(`Undo is off: ${off}.`, "warning"); return; }
      if (!checkpoints.length) { ctx.ui.notify("Nothing to undo yet: snapshots are taken before each prompt you send.", "info"); return; }
      if (!ctx.isIdle()) { ctx.ui.notify("Wait for pi to finish (or press Esc), then /undo.", "warning"); return; }
      const list = [...checkpoints].reverse();
      const labels = list.map((c, i) => `${i === 0 ? "Last prompt" : `${i + 1} prompts back`} (${ago(c.time)}): ${oneLine(c.prompt)}`);
      const pick = await ctx.ui.select("Undo file changes made since before which prompt?", labels);
      if (pick === undefined || pick === null) return;
      const cp = list[labels.indexOf(pick)];
      if (!cp) return;
      let now: string;
      try { now = store.snapshot("before undo"); } catch (e: any) { ctx.ui.notify(`Undo failed: ${e.message}`, "error"); return; }
      const changes = store.changes(now, cp.commit);
      if (!changes.length) { ctx.ui.notify("No file has changed since then; nothing to undo.", "info"); return; }
      const shown = changes.slice(0, 25).map((l) => l.replace(/^A /, "restore ").replace(/^D /, "delete  ").replace(/^M /, "revert  "));
      const ok = await ctx.ui.confirm(
        `Undo ${changes.length} file change${changes.length === 1 ? "" : "s"}?`,
        [...shown, ...(changes.length > shown.length ? [`… and ${changes.length - shown.length} more`] : []), "",
          "Files your .gitignore lists aren't touched. /undo again can bring these changes back."].join("\n"),
      );
      if (!ok) return;
      try { store.restore(cp.commit); } catch (e: any) { ctx.ui.notify(`Undo failed: ${e.message}`, "error"); return; }
      // The "before undo" state becomes a checkpoint, so the undo itself can be undone.
      const back: Checkpoint = { commit: now, prompt: `(the files just before undoing to: ${oneLine(cp.prompt, 50)})`, time: new Date().toISOString() };
      checkpoints = [...checkpoints, back].slice(-KEEP);
      pi.appendEntry(ENTRY, back);
      // The model still remembers its edits: tell it they're gone.
      pi.sendMessage({
        customType: ENTRY, display: true,
        content: `The owner undid file changes: the project's files are back to how they were before the prompt "${oneLine(cp.prompt, 120)}". ` +
          `Changed by the undo: ${changes.slice(0, 40).join(", ")}${changes.length > 40 ? ", …" : ""}. ` +
          "Edits you made after that point are gone from disk; read files again before changing them.",
      });
      ctx.ui.notify(`Undone: ${changes.length} file${changes.length === 1 ? "" : "s"} restored.`, "info");
    },
  });
}
