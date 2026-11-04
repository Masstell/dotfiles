// Advisor: a second opinion from a fresh context.
//
// The agent (tool `ask_advisor`) or the human (`/advisor`) asks a focused
// question — "is this the right approach for the next feature?", "I'm stuck on
// X" — and gets an answer from a model that has no tools and hasn't been
// staring at the same dead end. It sees the question, the asker's summary, and
// the tail of the conversation.
//
// By default it is the arbiter's default model in a fresh context: no swap, no
// cost to anyone else. Naming another model (e.g. "gemma") only works with a
// model-swap key. The advisor finds out which kind of key it holds on its own:
// a swap key answers an unknown model id with 404 model_not_found, refused
// before anything is unloaded; a standard key quietly serves the default. A
// swap evicts the default for every client, so swap calls have a cooldown.

import { Type } from "typebox";
import { chat, models } from "./arbiter.ts";
import type { Secrets } from "./secrets.ts";

const COOLDOWN_MS = (Number(process.env.PI_ADVISOR_SWAP_COOLDOWN_S || "") || 300) * 1000;
const TRANSCRIPT_CHARS = 12_000;

const SYSTEM = `You are a senior software engineer acting as an advisor to a coding
agent (or the human working with it). You cannot run tools or see the
repository; you see a question, the asker's summary of the situation, and the
tail of their conversation. Give a direct, concrete answer: what you would do
and why, the main risk or flaw in their current approach if there is one, and
what to check first if they are stuck. Be concise — a few short paragraphs or
a short list. If the summary is missing information you need, say exactly what
to look at rather than guessing.`;

let swapCapable: boolean | null = null; // null = not probed yet
let lastSwapAt = 0;

async function probeSwap(key: string, signal?: AbortSignal): Promise<boolean> {
  if (swapCapable !== null) return swapCapable;
  const res = await chat(
    { model: "__pi_advisor_swap_probe__", max_tokens: 1, chat_template_kwargs: { enable_thinking: false }, messages: [{ role: "user", content: "ok" }] },
    { key, signal, deadlineMs: 60_000 },
  );
  // Only a definite answer is cached; a timeout means "try again next time".
  if (res.status === 404 && res.code === "model_not_found") swapCapable = true;
  else if (res.ok) swapCapable = false;
  return swapCapable === true;
}

// "gemma" -> the catalog id containing it. Exact id wins; otherwise the first
// case-insensitive substring match among chat models.
async function resolveModel(key: string, wanted: string): Promise<string> {
  const catalog = await models(key);
  const ids = catalog.map((m) => String(m?.id || "")).filter(Boolean);
  if (ids.includes(wanted)) return wanted;
  const w = wanted.toLowerCase();
  return ids.find((id) => id.toLowerCase().includes(w)) || "";
}

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p: any) => (p?.type === "text" ? p.text : p?.type === "toolCall" ? `[tool call ${p.name}: ${JSON.stringify(p.arguments ?? {}).slice(0, 300)}]` : ""))
    .filter(Boolean)
    .join("\n");
}

// Tail of the active branch, newest kept, tool output trimmed hard.
function transcriptTail(ctx: any): string {
  let entries: any[] = [];
  try { entries = ctx?.sessionManager?.getBranch?.() ?? []; } catch { return ""; }
  const lines: string[] = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0 && used < TRANSCRIPT_CHARS; i--) {
    const m = entries[i]?.type === "message" ? entries[i].message : null;
    if (!m || m.role === "system") continue;
    let t = textOf(m.content).trim();
    if (!t) continue;
    if (m.role === "toolResult") t = `[${m.toolName} output] ${t.slice(0, 600)}`;
    const line = `${m.role.toUpperCase()}: ${t}`.slice(0, 3000);
    lines.unshift(line);
    used += line.length;
  }
  return lines.join("\n\n");
}

type Answer = { text: string; servedBy: string; note: string };

async function consult(key: string, question: string, summary: string, wantedModel: string, ctx: any, signal?: AbortSignal): Promise<Answer> {
  let model = "default";
  let note = "";
  if (wantedModel && wantedModel !== "default") {
    if (!(await probeSwap(key, signal))) {
      note = `This arbiter key can't swap models, so the default model answered instead of "${wantedModel}".`;
    } else if (Date.now() - lastSwapAt < COOLDOWN_MS) {
      const wait = Math.ceil((COOLDOWN_MS - (Date.now() - lastSwapAt)) / 1000);
      note = `Model swaps are on cooldown for another ${wait}s (each swap evicts the default model for every client), so the default model answered.`;
    } else {
      const id = await resolveModel(key, wantedModel);
      if (!id) note = `No arbiter model matches "${wantedModel}", so the default model answered.`;
      else { model = id; lastSwapAt = Date.now(); }
    }
  }
  const tail = transcriptTail(ctx);
  const user =
    `QUESTION:\n${question}\n\n` +
    (summary ? `ASKER'S SUMMARY OF THE SITUATION:\n${summary}\n\n` : "") +
    (tail ? `RECENT CONVERSATION (oldest first, tool output trimmed):\n${tail}\n` : "");
  const res = await chat(
    { model, max_tokens: 6144, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }] },
    {
      key, signal,
      onWait: (why) => { try { ctx?.ui?.setStatus?.("advisor", `⏳ advisor waiting for arbiter (${why})`); } catch { /* headless */ } },
    },
  ).finally(() => { try { ctx?.ui?.setStatus?.("advisor", undefined); } catch { /* headless */ } });
  if (!res.ok) throw new Error(`advisor request failed: HTTP ${res.status} ${res.code}`);
  // Reasoning models may leave thinking in the text channel; keep the answer.
  const text = res.text.replace(/<think>[\s\S]*?<\/think>/g, "").trim() || "(the advisor returned an empty answer)";
  return { text, servedBy: res.model || model, note };
}

export default function registerAdvisor(pi: any, secrets: Secrets) {
  if (!secrets.arbiterKey) return;
  const key = secrets.arbiterKey;

  pi.registerTool({
    name: "ask_advisor",
    label: "Ask advisor",
    description:
      "Get a second opinion from an advisor model in a fresh context (no tools, no repository access). " +
      "Use it before committing to a design for a non-trivial feature, when you have tried two approaches " +
      "that failed, or when you are unsure which of several options is right. Give a focused question and a " +
      "self-contained summary: goal, what you tried, what happened, the options you are weighing. " +
      "Optionally name another model (e.g. \"gemma\") for a genuinely different perspective; that swaps the " +
      "GPU (tens of seconds, and it evicts the default model for everyone), so reserve it for real dead ends. " +
      "If the key can't swap, the default model answers.",
    promptSnippet: "Ask an advisor model for a second opinion on a design or when stuck",
    parameters: Type.Object({
      question: Type.String({ description: "The specific question to answer" }),
      summary: Type.String({ description: "Self-contained context: goal, what was tried, what happened, options considered" }),
      model: Type.Optional(Type.String({ description: "Another model to ask (fuzzy, e.g. \"gemma\"); omit for the default model" })),
    }),
    async execute(_id: string, params: any, signal: AbortSignal, _onUpdate: any, ctx: any) {
      const a = await consult(key, params.question, params.summary || "", params.model || "", ctx, signal);
      return {
        content: [{ type: "text", text: `${a.note ? a.note + "\n\n" : ""}Advisor (${a.servedBy}):\n${a.text}` }],
        details: { servedBy: a.servedBy, note: a.note },
      };
    },
  });

  // For the human: `/advisor [model=<name>] <question>`. The answer lands in
  // the conversation so the agent sees it too.
  pi.registerCommand("advisor", {
    description: "Ask the advisor model for a second opinion (optional model=<name> first)",
    handler: async (args: string, ctx: any) => {
      let rest = (args || "").trim();
      let wanted = "";
      const m = rest.match(/^model=(\S+)\s+([\s\S]*)$/);
      if (m) { wanted = m[1]; rest = m[2]; }
      if (!rest) { ctx.ui.notify("Usage: /advisor [model=<name>] <question>", "info"); return; }
      ctx.ui.notify("Asking the advisor…", "info");
      try {
        const a = await consult(key, rest, "", wanted, ctx);
        pi.sendMessage({
          customType: "advisor",
          content: `${a.note ? a.note + "\n\n" : ""}Advisor (${a.servedBy}) on "${rest}":\n\n${a.text}`,
          display: true,
          details: { servedBy: a.servedBy },
        });
      } catch (err: any) {
        ctx.ui.notify(String(err?.message || err), "error");
      }
    },
  });
}
