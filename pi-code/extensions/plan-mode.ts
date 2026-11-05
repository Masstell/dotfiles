// Plan mode: look first, change nothing, then agree on a plan.
//
// /plan (or `pi --plan`) toggles it. While it is on:
//   - edit and write are switched off (and blocked if called anyway);
//   - bash runs only commands that read (the allowlist below), still
//     classified as usual;
//   - subagents run in explore mode only;
//   - the model is told to investigate, ask with ask_user when a choice is
//     yours, and end with a numbered plan.
// When a turn ends with a numbered plan, pi asks: execute it, keep planning,
// or leave plan mode. Adapted from pi's examples/extensions/plan-mode.

export const PLAN_STASH = Symbol.for("homelab.pi.planMode");
const WRITE_TOOLS = new Set(["edit", "write"]);

// Each piece of a command line (split on | ; && || outside quotes) must start
// with one of these, and nothing may write a file.
const READ_ONLY = [
  /^(cat|head|tail|less|more|grep|egrep|fgrep|rg|fd|fdfind|find|ls|tree|pwd|echo|printf|wc|sort|uniq|cut|tr|column|diff|cmp|file|stat|du|df|which|whereis|type|realpath|readlink|basename|dirname|jq|yq|awk|nl|tac|rev|true|false|test)\b/,
  /^sed\s+-n\b/,
  /^git\s+(status|log|diff|show|branch|remote|ls-files|ls-tree|grep|blame|rev-parse|describe|shortlog|config\s+--get)\b/,
  /^(npm|pnpm|yarn)\s+(ls|list|view|info|outdated|why)\b/,
  /^(pip3?|uv\s+pip)\s+(list|show|freeze)\b/,
  /^(node|python3?|go|cargo|rustc|ruby|java|docker)\s+(--version|-V|version)\b/,
  /^docker\s+(ps|images|inspect|logs|compose\s+(ps|config|logs))\b/,
  /^(uname|whoami|id|date|uptime|free|ps|env|printenv|hostname|lsblk|ip\s+(a|addr|r|route))\b/,
  /^systemctl\s+(status|is-active|is-enabled|list-units|cat)\b/,
  /^journalctl\b/,
  /^(curl|wget)\b/, // reading the web; the classifier still judges it
];
// Checked with quoted text blanked out (a pattern like 'a|b' or "=>" is fine).
const NEVER = [
  /(^|[^<>])>{1,2}(?!&|\s*\/dev\/null\b)/, // redirect into a file (2>&1, >&2, >/dev/null are fine)
  /\b(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|tee|truncate|dd|shred|install|patch|xargs)\b/,
  /\bsed\b.*\s-i/,
  /\bawk\b.*\bsystem\b/,
  /\bfind\b.*\s-(delete|exec|execdir|ok|fprint)/,
  /\b(curl|wget)\b.*\s(-o|-O|--output|-T|--upload-file|-d|--data|-F|--form|-X\s*(POST|PUT|DELETE|PATCH))\b/,
];

/** Blank out quoted strings, keeping length; unbalanced quotes blank to the end. */
function blankQuotes(cmd: string): string {
  return cmd.replace(/'[^']*('|$)|"(\\.|[^"\\])*("|$)/g, (m) => " ".repeat(m.length));
}

export function isReadOnlyCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  // Command substitution runs inside double quotes too: check the raw text.
  if (/\$\(|`|<\(|>\(/.test(cmd)) return false;
  const bare = blankQuotes(cmd);
  if (NEVER.some((p) => p.test(bare))) return false;
  // Split on the bare text's operators, at the same offsets in the original.
  const parts: string[] = [];
  let start = 0;
  for (const m of bare.matchAll(/\|\||&&|\|&?|;|\n|(?<!>)&(?!>)/g)) {
    parts.push(cmd.slice(start, m.index));
    start = m.index! + m[0].length;
  }
  parts.push(cmd.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean).every((p) => READ_ONLY.some((r) => r.test(p)));
}

const CONTEXT = `[PLAN MODE]
You are in plan mode: investigate and plan, change nothing.
- edit and write are off; bash runs only read-only commands.
- Read the relevant code, check your assumptions, and look up anything you are unsure about.
- When a decision is the user's to make, ask with ask_user instead of guessing.
- End with a numbered plan under a "Plan:" heading: concrete steps, files to touch, how to verify. Note risks and open questions.`;

export default function registerPlanMode(pi: any) {
  const g = globalThis as any;
  g[PLAN_STASH] ??= { on: false, toolsBefore: undefined as string[] | undefined };
  const state = g[PLAN_STASH] as { on: boolean; toolsBefore?: string[] };

  pi.registerFlag?.("plan", { description: "Start in plan mode (read-only investigation)", type: "boolean", default: false });

  const show = (ctx: any) => {
    try { ctx?.ui?.setStatus?.("plan-mode", state.on ? "⏸ plan" : undefined); } catch { /* headless */ }
  };
  const apply = (on: boolean, ctx: any, persist = true) => {
    if (on === state.on && persist) return;
    state.on = on;
    if (on) {
      state.toolsBefore = pi.getActiveTools();
      pi.setActiveTools(state.toolsBefore!.filter((t: string) => !WRITE_TOOLS.has(t)));
    } else {
      const before = state.toolsBefore ?? pi.getActiveTools();
      pi.setActiveTools([...new Set([...before, ...pi.getActiveTools()])]);
      state.toolsBefore = undefined;
    }
    if (persist) pi.appendEntry("plan-mode", { on });
    show(ctx);
  };

  pi.registerCommand("plan", {
    description: "Toggle plan mode: investigate and plan, change nothing",
    handler: async (_args: string, ctx: any) => {
      apply(!state.on, ctx);
      ctx.ui.notify(state.on ? "Plan mode on: edit/write off, read-only bash. /plan again to leave." : "Plan mode off: full tools back.", "info");
    },
  });

  pi.on("session_start", async (_event: any, ctx: any) => {
    let on = false;
    try {
      for (const e of ctx?.sessionManager?.getBranch?.() ?? []) {
        if (e?.type === "custom" && e?.customType === "plan-mode") on = !!e?.data?.on;
      }
    } catch { /* no history */ }
    if (pi.getFlag?.("plan") && !process.env.PI_SUBAGENT) on = true;
    state.on = false;
    state.toolsBefore = undefined;
    if (on) apply(true, ctx, false);
    show(ctx);
  });

  // A subagent worker started while the main session is in plan mode.
  const workerReadOnly = !!process.env.PI_SUBAGENT && process.env.PI_SUBAGENT_READONLY === "1";
  delete process.env.PI_SUBAGENT_READONLY;

  pi.on("tool_call", async (event: any) => {
    if (!state.on && !workerReadOnly) return undefined;
    const tool = String(event?.toolName || "");
    if (WRITE_TOOLS.has(tool)) return { block: true, reason: "Plan mode: no file changes. Finish the plan; the user leaves plan mode with /plan." };
    if (tool === "bash" && !isReadOnlyCommand(String(event?.input?.command || ""))) {
      return { block: true, reason: "Plan mode: bash runs only read-only commands (no redirects, no file changes, no command substitution). Note the step in the plan instead." };
    }
    return undefined;
  });

  pi.on("before_agent_start", async (event: any) => {
    if (!state.on || event?.messageType !== "user") return undefined;
    return { message: { customType: "plan-mode-context", content: CONTEXT, display: false } };
  });

  // Old plan-mode reminders shouldn't keep steering once plan mode is off.
  pi.on("context", async (event: any) => {
    if (state.on) return undefined;
    const messages = event?.messages;
    if (!Array.isArray(messages)) return undefined;
    return { messages: messages.filter((m: any) => m?.customType !== "plan-mode-context") };
  });

  pi.on("agent_end", async (event: any, ctx: any) => {
    if (!state.on || !ctx?.hasUI) return;
    const last = [...(event?.messages || [])].reverse().find((m: any) => m?.role === "assistant");
    const text = Array.isArray(last?.content) ? last.content.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n") : "";
    if (!/^\s*(\*\*)?plan:?(\*\*)?\s*$/im.test(text) && !/^\s*1[.)]\s+\S/m.test(text)) return;
    const choice = await ctx.ui.select("Plan ready. What next?", ["Execute the plan", "Keep planning", "Leave plan mode"]);
    if (choice === "Execute the plan") {
      apply(false, ctx);
      pi.sendUserMessage("Plan mode is off. Execute the plan above, step by step. Verify each step as the plan says, and tell me if something doesn't match what the plan expected.");
    } else if (choice === "Leave plan mode") {
      apply(false, ctx);
      ctx.ui.notify("Plan mode off: full tools back.", "info");
    }
  });
}
