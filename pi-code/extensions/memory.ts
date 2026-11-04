// Project memory: remember / forget tools, a code-built index frozen per
// session, keyword recall per user message, and /memories. Logic lives in
// memory-core.ts; this file is the pi glue.
//
// Poisoning guard: memory outlives the session, so one bad write keeps
// steering later ones. Every save is shown to the user, and a save in a run
// that read the web (web_fetch / web_search) asks the user first.
//
// Claude Code's memory for the project can be shown read-only (its index
// only) with PI_CLAUDE_MEMORY=1 or `/memories claude on`. pi never writes it.

import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import {
  LIMITS, TYPES, archiveNote, buildIndex, checkCandidate, claudeMemoryDir, loadNotes, memoryDir,
  recall, recallMessage, restoreNote, writeNote,
} from "./memory-core.ts";

const ON = /^(1|true|yes|on)$/i;
const WEB_TOOLS = new Set(["web_fetch", "web_search"]);

export default function registerMemory(pi: any) {
  const dir = memoryDir(process.cwd());
  let claudeOn = ON.test(process.env.PI_CLAUDE_MEMORY || "");
  let snapshot = "";                  // the index section, rebuilt only at session start / compaction / toggle
  let recalled = new Set<string>();   // name@updated already injected this session
  let webThisRun = false;

  const rebuild = () => {
    let claude: { dir: string; index: string } | undefined;
    if (claudeOn) {
      const cdir = claudeMemoryDir(process.cwd());
      if (cdir) {
        try { claude = { dir: cdir, index: fs.readFileSync(path.join(cdir, "MEMORY.md"), "utf8") }; } catch { /* unreadable */ }
      }
    }
    snapshot = buildIndex(dir, loadNotes(dir), claude);
  };
  rebuild();

  pi.on("session_start", async () => { recalled = new Set(); rebuild(); });
  pi.on("session_compact", async () => { rebuild(); });

  // Memory changes only through remember/forget, where the checks and the
  // user-visible notices live. The directory itself is writable (it has to
  // be, for this process), so shell and file tools are kept off it.
  const realDir = (() => { try { return fs.realpathSync(dir); } catch { return dir; } })();
  pi.on("tool_call", async (event: any) => {
    const tool = String(event?.toolName || "");
    if (WEB_TOOLS.has(tool)) webThisRun = true;
    const input = event?.input || {};
    if (tool === "bash") {
      const cmd = String(input.command || "");
      if (/pi-memory/.test(cmd) || cmd.includes(dir) || cmd.includes(realDir)) {
        return { block: true, reason: "Project memory changes only through the remember and forget tools; read notes with the read tool." };
      }
    } else if (!["read", "ls", "grep", "find", "remember", "forget"].includes(tool)) {
      const p = String(input.path || input.file_path || "");
      if (p) {
        let abs = path.resolve(process.cwd(), p.replace(/^~(?=\/|$)/, process.env.HOME || "~"));
        try { abs = fs.realpathSync(path.dirname(abs)) + path.sep + path.basename(abs); } catch { /* new path */ }
        if (abs.startsWith(realDir + path.sep) || abs.startsWith(dir + path.sep)) {
          return { block: true, reason: "Project memory changes only through the remember and forget tools." };
        }
      }
    }
    return undefined;
  });

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    // The index is the same text every run, so pi's section diff sends nothing
    // new and the arbiter's prompt cache stays warm.
    const sections = event?.systemPromptOptions?.sections;
    if (sections) {
      if (snapshot) sections.memory = snapshot;
      else delete sections.memory;
    }
    if (event?.messageType !== "user") return undefined;
    webThisRun = false;
    const hits = recall(String(event.prompt || ""), loadNotes(dir), recalled);
    if (!hits.length) return undefined;
    for (const h of hits) recalled.add(`${h.note.name}@${h.note.updated}`);
    try { ctx?.ui?.notify?.(`🧠 recalled: ${hits.map((h) => h.note.name).join(", ")}`, "info"); } catch { /* headless */ }
    return { message: { customType: "memory-recall", content: recallMessage(hits), display: false } };
  });

  pi.registerTool({
    name: "remember",
    label: "Remember",
    description:
      "Save a note to this project's long-term memory, for future sessions. One fact or decision per note. " +
      "Reusing an existing note's name updates it (the old version is archived).",
    promptSnippet: "Save a non-obvious fact or decision to project memory for future sessions",
    promptGuidelines: [
      "Use remember for what a future session could not work out from the code or git history: the user's " +
        "preferences and corrections, decisions and the reason for them, gotchas that cost time, where things " +
        "live outside the repo. Most sessions need no new note.",
      "Never use remember for task progress, code structure, anything copied from a web page, or secrets.",
      "Before calling remember, check the memory index: update an existing note by reusing its name instead of " +
        "adding a near-duplicate.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "kebab-case id, e.g. deploy-needs-vpn" }),
      description: Type.String({ description: "One line: what this note is about (used for recall)" }),
      keywords: Type.Optional(Type.Array(Type.String(), { description: "Up to 8 search terms, including synonyms" })),
      type: Type.String({ description: `One of: ${TYPES.join(", ")}` }),
      content: Type.String({ description: `The note itself, under ${LIMITS.bodyChars} characters. Include the why.` }),
    }),
    async execute(_id: string, params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      const cand = {
        name: String(params.name || "").trim(),
        description: String(params.description || "").trim(),
        keywords: (Array.isArray(params.keywords) ? params.keywords : []).map((k: any) => String(k).trim().toLowerCase()).filter(Boolean),
        type: String(params.type || "").trim(),
        content: String(params.content || ""),
      };
      const notes = loadNotes(dir);
      const err = checkCandidate(cand, notes);
      if (err) return { content: [{ type: "text", text: `Not saved: ${err}` }], isError: true, details: { saved: false } };

      if (webThisRun) {
        const ok = ctx?.hasUI
          ? await ctx.ui.confirm(
              "Save to project memory?",
              `This run read the web, so pi asks before remembering.\n\n${cand.name}: ${cand.description}\n\n${cand.content.slice(0, 1200)}`,
            )
          : false;
        if (!ok) {
          return {
            content: [{ type: "text", text: "Not saved: the user did not approve saving memory in a run that read web content." }],
            isError: true, details: { saved: false },
          };
        }
      }

      const updating = notes.some((n) => n.name === cand.name);
      writeNote(dir, {
        name: cand.name, description: cand.description, keywords: cand.keywords, type: cand.type,
        source: webThisRun ? "agent+web" : "agent", updated: new Date().toISOString().slice(0, 10), body: cand.content,
      });
      try { ctx?.ui?.notify?.(`🧠 ${updating ? "updated" : "saved"} memory: ${cand.name} — ${cand.description}`, "info"); } catch { /* headless */ }
      return {
        content: [{ type: "text", text: `${updating ? "Updated" : "Saved"} "${cand.name}". It is recallable now and joins the index next session.` }],
        details: { saved: true, updated: updating },
      };
    },
  });

  pi.registerTool({
    name: "forget",
    label: "Forget",
    description: "Remove a note from project memory (it is archived, and the user can restore it).",
    promptSnippet: "Remove an outdated or wrong note from project memory",
    parameters: Type.Object({ name: Type.String({ description: "The note's name" }) }),
    async execute(_id: string, params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      const name = String(params.name || "").trim();
      if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(name) || !archiveNote(dir, name)) {
        return { content: [{ type: "text", text: `No note named "${name}".` }], isError: true, details: {} };
      }
      try { ctx?.ui?.notify?.(`🧠 forgot memory: ${name} (/memories restore ${name} undoes it)`, "info"); } catch { /* headless */ }
      return { content: [{ type: "text", text: `Forgot "${name}" (archived).` }], details: {} };
    },
  });

  pi.registerCommand("memories", {
    description: "Project memory: list | show <name> | forget <name> | restore <name> | claude on|off",
    handler: async (args: string, ctx: any) => {
      const [sub = "", arg = ""] = (args || "").trim().split(/\s+/, 2);
      const say = (t: string, level = "info") => ctx.ui.notify(t, level);
      const notes = loadNotes(dir);
      switch (sub) {
        case "":
        case "list": {
          if (!notes.length) return say(`No notes yet for this project.\n${dir}`);
          return say(
            `${notes.length} note(s) in ${dir}\n` +
            notes.map((n) => `  ${n.name} — ${n.description} (${n.type}, ${n.updated}${n.source !== "agent" ? `, ${n.source}` : ""})`).join("\n") +
            `\nClaude memory: ${claudeOn ? "on" : "off"}`,
          );
        }
        case "show": {
          const n = notes.find((x) => x.name === arg);
          return n ? say(fs.readFileSync(n.file, "utf8")) : say(`No note named "${arg}".`, "warning");
        }
        case "forget":
          return archiveNote(dir, arg) ? say(`Forgot "${arg}" (archived).`) : say(`No note named "${arg}".`, "warning");
        case "restore":
          return /^[a-z0-9][a-z0-9-]{0,59}$/.test(arg) && restoreNote(dir, arg)
            ? say(`Restored "${arg}". It joins the index next session.`)
            : say(`Nothing archived under "${arg}".`, "warning");
        case "claude": {
          if (arg !== "on" && arg !== "off") return say(`Claude memory is ${claudeOn ? "on" : "off"}. Use /memories claude on|off.`);
          claudeOn = arg === "on";
          rebuild();
          const found = claudeOn ? claudeMemoryDir(process.cwd()) : undefined;
          return say(claudeOn ? (found ? `Claude memory on (index from ${found}).` : "Claude memory on, but Claude has no memory for this project.") : "Claude memory off.");
        }
        default:
          return say("Usage: /memories [list | show <name> | forget <name> | restore <name> | claude on|off]", "warning");
      }
    },
  });
}
