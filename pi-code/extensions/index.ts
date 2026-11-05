// Homelab extensions for pi, loaded from ~/.pi/agent/extensions/homelab
// (install.sh symlinks this directory there). pi auto-discovers index.ts; the
// other files are modules, not separate extensions.
//
//   arbiter-provider  provider "arbiter", model "default" (the local GPU)
//   bash-classifier   tool_call gate: every non-trivial bash command is judged
//   advisor           ask_advisor tool + /advisor command (second opinion)
//   web-search        web_search (Brave, when a key is set) + web_fetch
//   memory            per-project memory: remember/forget, index, recall, /memories
//   lint              after edit/write, syntax and lint problems join the tool result
//   ask-user          ask_user tool: a question with choices, when a decision is yours
//   plan-mode         /plan: investigate and plan with no file changes
//   subagent          subagent tool: up to 3 parallel workers with their own context

import registerArbiter from "./arbiter-provider.ts";
import registerClassifier from "./bash-classifier.ts";
import registerAdvisor from "./advisor.ts";
import registerWebTools from "./web-search.ts";
import registerMemory from "./memory.ts";
import registerLint from "./lint.ts";
import registerAskUser from "./ask-user.ts";
import registerPlanMode from "./plan-mode.ts";
import registerSubagent from "./subagent.ts";
import { readSecrets } from "./secrets.ts";

export default async function (pi: any) {
  // pi.sh starts pi with NODE_OPTIONS=--disable-sigusr1 (no inspector on
  // SIGUSR1). Only pi's own process needs it; an older Node the agent runs
  // (nvm, volta, a tool's bundled Node) would refuse the flag and not start.
  if (process.env.NODE_OPTIONS === "--disable-sigusr1") delete process.env.NODE_OPTIONS;
  const secrets = readSecrets();
  // The gate first, and outside any try: if anything below fails, bash must
  // still be classified, not run unchecked.
  registerClassifier(pi, secrets);
  // A project's own .pi/extensions and skills would run inside pi's process,
  // where the keys are, and the agent can write them. Decline every project,
  // whatever trust.json or defaultProjectTrust say (a user extension's answer wins).
  pi.on("project_trust", async () => ({ trusted: "no" }));
  for (const [name, register] of [
    ["arbiter provider", registerArbiter],
    ["advisor", registerAdvisor],
    ["web tools", registerWebTools],
    ["memory", registerMemory],
    ["lint", registerLint],
    ["plan mode", registerPlanMode],
    ["subagent", registerSubagent],
    // Workers run headless: nobody to ask.
    ...(process.env.PI_SUBAGENT ? [] : ([["ask_user", registerAskUser]] as const)),
  ] as const) {
    try {
      await register(pi, secrets);
    } catch (err: any) {
      console.error(`homelab extensions: ${name} failed to load: ${String(err?.message || err)}`);
    }
  }
}
