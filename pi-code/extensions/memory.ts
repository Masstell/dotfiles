// Project memory: remember / forget tools, a code-built index frozen per
// session, keyword recall per user message, and /memories. Logic lives in
// memory-core.ts; this file is the pi glue.
//
// Poisoning guards: memory outlives the session, so one bad write keeps
// steering later ones.
// - Only remember writes notes that count: each is signed with a key pi gets
//   on fd 3 (PI_MEMORY_KEY), and unsigned or altered files are ignored.
// - Every save is shown to the user. Once the session has taken in web
//   content (web_fetch, web_search, curl/wget/git clone in bash), every
//   further save asks the user first; headless runs refuse.
// - In a read-only session (pi started outside a project) memory is read-only.
//
// Claude Code's memory for the project can be shown read-only (its index
// only) with PI_CLAUDE_MEMORY=1 or `/memories claude on`. pi never writes it.

import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { Secrets } from "./secrets.ts";
import {
  LIMITS, NAME_RE, TYPES, archiveNote, buildIndex, checkCandidate, claudeMemoryDir, loadNotes, memoryDir,
  recall, recallKey, recallMessage, restoreNote, writeNote,
} from "./memory-core.ts";

const ON = /^(1|true|yes|on)$/i;
const WEB_TOOLS = new Set(["web_fetch", "web_search"]);
// Commands that bring outside text into the conversation: downloads, URLs,
// GitHub issue/PR text, package installs (their output and scripts).
const WEB_BASH = new RegExp(
  [
    String.raw`\b(curl|wget|aria2c|lynx|w3m|httpie)\b`,
    String.raw`\bgit\s+clone\b`,
    String.raw`https?://`,
    String.raw`\bgh\s+(issue|pr|api|release|repo\s+view|search|gist)\b`,
    String.raw`\b(pip3?|uv\s+pip|npm|pnpm|yarn|bun|cargo|go|gem)\s+(install|add|i|get)\b`,
    String.raw`\b(urllib|requests\.get|httpx|fetch\()`,
  ].join("|"),
  "i",
);
// Path-shaped mentions of the memory folder (not prose about it).
const MEM_PATH = /share\/pi-m|pi-mem[a-z*?]*\/|(^|[;&|\s])cd\s[^;&|]*pi-mem|\bPI_MEMORY/;
// pi re-registers extensions on /reload, /new, /resume and /fork, after the
// launcher's env values were already removed; keep them here.
const STASH = Symbol.for("homelab.pi.memory");

/** Resolve a tool path the way pi does (strip "@", file:// URLs, ~), then follow symlinks. */
function resolveToolPath(p: string, cwd: string): string {
  let s = p.trim().replace(/[  -​  　]/g, " ");
  if (s.startsWith("@")) s = s.slice(1);
  if (/^file:\/\//i.test(s)) { try { s = decodeURIComponent(new URL(s).pathname); } catch { /* keep */ } }
  s = s.replace(/^~(?=\/|$)/, process.env.HOME || "~");
  let abs = path.resolve(cwd, s);
  try { return fs.realpathSync(abs); } catch { /* new file */ }
  try { abs = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); } catch { /* new dir */ }
  return abs;
}

export default function registerMemory(pi: any, secrets: Secrets) {
  const g = globalThis as any;
  g[STASH] ??= { dir: memoryDir(process.cwd()), readOnly: ON.test(process.env.PI_MEMORY_READONLY || "") };
  const { dir, readOnly } = g[STASH] as { dir: string; readOnly: boolean };
  // Bash inherits pi's environment; nothing here should point it at memory.
  delete process.env.PI_MEMORY_DIR;
  delete process.env.PI_MEMORY_READONLY;
  const key = secrets.memoryKey;
  const realDir = (() => { try { return fs.realpathSync(dir); } catch { return dir; } })();
  let claudeOn = ON.test(process.env.PI_CLAUDE_MEMORY || "");
  let snapshot = "";                 // the index section; rebuilt at session start / compaction / toggle
  let recalled = new Set<string>();  // note versions already injected this session
  let webTainted = false;            // the session has taken in web content

  const notes = () => loadNotes(dir, key);
  const rebuild = () => {
    let claude: { dir: string; index: string } | undefined;
    if (claudeOn) {
      const cdir = claudeMemoryDir(process.cwd());
      if (cdir) {
        try { claude = { dir: cdir, index: fs.readFileSync(path.join(cdir, "MEMORY.md"), "utf8") }; } catch { /* unreadable */ }
      }
    }
    snapshot = key ? buildIndex(dir, notes().notes, claude) : buildIndex(dir, [], claude);
  };

  // Rebuild what this session already contains: web content in its history,
  // and notes already recalled into it (so a resumed session isn't re-fed).
  const scanBranch = (ctx: any) => {
    webTainted = false;
    recalled = new Set();
    let entries: any[] = [];
    try { entries = ctx?.sessionManager?.getBranch?.() ?? []; } catch { return; }
    const byName = new Map(notes().notes.map((n) => [n.name, n]));
    for (const e of entries) {
      // Recalls before the latest compaction were summarized away: recall again.
      if (e?.type === "compaction") recalled = new Set();
      const m = e?.message;
      if (m?.role === "toolResult" && WEB_TOOLS.has(String(m.toolName))) webTainted = true;
      if (m?.role === "bashExecution" && WEB_BASH.test(String(m.command || ""))) webTainted = true;
      if (m?.role === "assistant" && Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part?.type === "toolCall" && part.name === "bash" && WEB_BASH.test(String(part.arguments?.command || ""))) webTainted = true;
          if (part?.type === "toolCall" && WEB_TOOLS.has(String(part.name))) webTainted = true;
        }
      }
      if (e?.customType === "memory-recall" || m?.customType === "memory-recall") {
        for (const name of (e?.details?.names || m?.details?.names || []) as string[]) {
          const n = byName.get(name);
          if (n) recalled.add(recallKey(n));
        }
      }
    }
  };

  rebuild();
  pi.on("session_start", async (_event: any, ctx: any) => {
    scanBranch(ctx);
    rebuild();
    const bad = notes().ignored.filter((i) => /signature/.test(i));
    if (bad.length) {
      try { ctx?.ui?.notify?.(`🧠 ${bad.length} memory file(s) ignored: not saved through remember (/memories lists them)`, "warning"); } catch { /* headless */ }
    }
  });
  pi.on("session_compact", async () => { recalled = new Set(); rebuild(); });
  // Your own `!cmd` runs land in the conversation too.
  pi.on("user_bash", async (event: any) => {
    if (!event?.excludeFromContext && WEB_BASH.test(String(event?.command || ""))) webTainted = true;
    return undefined;
  });

  // Memory changes only through remember/forget. The folder is writable for
  // this process, so shell and file tools are kept off it. (Unsigned files
  // are ignored anyway; this stops deletes and clutter.)
  pi.on("tool_call", async (event: any) => {
    const tool = String(event?.toolName || "");
    const input = event?.input || {};
    if (WEB_TOOLS.has(tool)) webTainted = true;
    if (tool === "bash") {
      const cmd = String(input.command || "");
      if (WEB_BASH.test(cmd)) webTainted = true;
      if (MEM_PATH.test(cmd) || cmd.includes(dir) || cmd.includes(realDir)) {
        return { block: true, reason: "Project memory changes only through the remember and forget tools; read notes with the read tool." };
      }
    } else if (!["read", "ls", "grep", "find", "remember", "forget"].includes(tool)) {
      const raw = String(input.path || input.file_path || "");
      if (raw) {
        const abs = resolveToolPath(raw, process.cwd());
        if (MEM_PATH.test(raw) || abs === realDir || abs.startsWith(realDir + path.sep) || abs.startsWith(dir + path.sep)) {
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
    if (event?.messageType !== "user" || !key) return undefined;
    const hits = recall(String(event.prompt || ""), notes().notes, recalled);
    if (!hits.length) return undefined;
    for (const h of hits) recalled.add(recallKey(h.note));
    try { ctx?.ui?.notify?.(`🧠 recalled: ${hits.map((h) => h.note.name).join(", ")}`, "info"); } catch { /* headless */ }
    return {
      message: {
        customType: "memory-recall", content: recallMessage(hits), display: false,
        details: { names: hits.map((h) => h.note.name) },
      },
    };
  });

  const unavailable = () =>
    !key ? "project memory is unavailable (no memory key: pi.sh creates one in ~/.config/pi-agent/memory.key)."
      : readOnly ? "project memory is read-only in this session (pi was started outside a project)." : "";

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
      keywords: Type.Optional(Type.Array(Type.String(), { description: "Up to 8 short lowercase search terms, including synonyms" })),
      type: Type.String({ description: `One of: ${TYPES.join(", ")}` }),
      content: Type.String({ description: `The note itself, under ${LIMITS.bodyChars} characters. Include the why.` }),
    }),
    async execute(_id: string, params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      const fail = (text: string) => ({ content: [{ type: "text", text: `Not saved: ${text}` }], isError: true, details: { saved: false } });
      const why = unavailable();
      if (why) return fail(why);
      const cand = {
        name: String(params.name || "").trim(),
        description: String(params.description || "").trim(),
        keywords: (Array.isArray(params.keywords) ? params.keywords : []).map((k: any) => String(k).trim().toLowerCase()).filter(Boolean),
        type: String(params.type || "").trim(),
        content: String(params.content || ""),
      };
      const current = notes().notes;
      const err = checkCandidate(cand, current);
      if (err) return fail(err);

      if (webTainted) {
        const ok = ctx?.hasUI
          ? await ctx.ui.confirm(
              "Save to project memory?",
              "This session has read web content, so pi asks before remembering.\n\n" +
                `${cand.name}: ${cand.description}\nkeywords: ${cand.keywords.join(", ") || "(none)"}\n\n${cand.content.slice(0, 1200)}`,
            )
          : false;
        if (!ok) return fail("the user did not approve saving memory in a session that has read web content.");
      }

      const updating = current.some((n) => n.name === cand.name);
      writeNote(dir, {
        name: cand.name, description: cand.description, keywords: cand.keywords, type: cand.type,
        source: webTainted ? "agent+web" : "agent", updated: new Date().toISOString(), body: cand.content,
      }, key);
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
      const why = unavailable();
      if (why) return { content: [{ type: "text", text: `Not changed: ${why}` }], isError: true, details: {} };
      const name = String(params.name || "").trim();
      if (!notes().notes.some((n) => n.name === name)) return { content: [{ type: "text", text: `No note named "${name}".` }], isError: true, details: {} };
      if (webTainted) {
        const ok = ctx?.hasUI
          ? await ctx.ui.confirm("Forget a project memory note?", `This session has read web content, so pi asks first.\n\nForget "${name}"? (It is archived; /memories restore brings it back.)`)
          : false;
        if (!ok) return { content: [{ type: "text", text: "Not changed: the user did not approve forgetting in a session that has read web content." }], isError: true, details: {} };
      }
      archiveNote(dir, name, key);
      try { ctx?.ui?.notify?.(`🧠 forgot memory: ${name} (/memories restore ${name} undoes it)`, "info"); } catch { /* headless */ }
      return { content: [{ type: "text", text: `Forgot "${name}" (archived).` }], details: {} };
    },
  });

  pi.registerCommand("memories", {
    description: "Project memory: list | show <name> | forget <name> | restore <name> | claude on|off",
    handler: async (args: string, ctx: any) => {
      const [sub = "", arg = ""] = (args || "").trim().split(/\s+/, 2);
      const say = (t: string, level = "info") => ctx.ui.notify(t, level);
      const { notes: list, ignored } = notes();
      const valid = NAME_RE.test(arg);
      switch (sub) {
        case "":
        case "list": {
          const lines = [
            list.length ? `${list.length} note(s) in ${dir}` : `No notes yet for this project.\n${dir}`,
            ...list.map((n) => `  ${n.name} — ${n.description} (${n.type}, ${n.updated.slice(0, 10)}${n.source !== "agent" ? `, ${n.source}` : ""})`),
          ];
          if (ignored.length) lines.push(`Ignored (not saved through remember): ${ignored.join("; ")}`);
          if (!key) lines.push("Memory key missing: notes can't be verified or saved.");
          if (readOnly) lines.push("Read-only in this session.");
          lines.push(`Claude memory: ${claudeOn ? "on" : "off"}`);
          return say(lines.join("\n"));
        }
        case "show": {
          const n = list.find((x) => x.name === arg);
          return n ? say(fs.readFileSync(n.file, "utf8")) : say(`No note named "${arg}".`, "warning");
        }
        case "forget":
          if (readOnly) return say("Memory is read-only in this session.", "warning");
          return valid && archiveNote(dir, arg, key) ? say(`Forgot "${arg}" (archived).`) : say(`No note named "${arg}".`, "warning");
        case "restore":
          if (readOnly) return say("Memory is read-only in this session.", "warning");
          return valid && restoreNote(dir, arg, key)
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
