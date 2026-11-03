// Local bash-safety classifier for pi.
//
// pi ships no permission system ("build your own confirmation flow with
// extensions"). This is that flow: a `tool_call` hook that gates every bash
// command through the arbiter's default model and FAILS CLOSED — unreachable
// past the deadline, unparseable, or a bug in this hook all block, matching how
// Claude Code's auto mode denies when its classifier is unavailable.
//
// Inside the sandbox (pi.sh sets PI_SANDBOX=1) the classifier uses the sandbox
// policy: bubblewrap already stops writes outside the project, secret reads,
// and privilege escalation, so the model only judges what it can't — docker,
// hidden code, data leaving the machine, publishing, LAN infrastructure.
//
// PI_LOCAL_READONLY=1 turns this into a plan / read-only gate: bash writes and
// any edit-style tool are hard-blocked regardless of the model.
//
// Decision logic lives in classifier-core.ts so the eval runs the same code.

import { chat } from "./arbiter.ts";
import {
  fastPathSafe, isClaudeMode, isReadOnlyTool, loadPolicy, parseVerdict,
  policyPath, requestBody, scanCommand, userContent, type Verdict,
} from "./classifier-core.ts";
import type { Secrets } from "./secrets.ts";

const SANDBOXED = process.env.PI_SANDBOX === "1";
const READONLY = /^(1|true|yes|on)$/i.test(process.env.PI_LOCAL_READONLY || "");
const POLICY_PATH = policyPath(SANDBOXED);
const POLICY = loadPolicy(POLICY_PATH);
const CLAUDE_MODE = isClaudeMode(POLICY);
// Past the arbiter's 600 s wait budget: after an advisor swap the next verdict
// legitimately waits for the default model to come back.
const DEADLINE_MS = Number(process.env.PI_CLASSIFIER_DEADLINE_MS || "") || 660_000;

async function classify(command: string, cwd: string, scan: { files: any[] }, key: string, ctx: any): Promise<Verdict> {
  if (!key) return { decision: "block", reason: "classifier not configured (no arbiter key)" };
  if (POLICY === null) return { decision: "block", reason: `policy file unreadable: ${POLICY_PATH} (failing closed)` };
  const content = userContent(command, cwd, scan.files, CLAUDE_MODE, process.env.PI_PROJECT_DIR || "");
  try {
    const res = await chat(requestBody(POLICY, content, CLAUDE_MODE), {
      key,
      signal: ctx?.signal,
      deadlineMs: DEADLINE_MS,
      onWait: (why) => {
        try { ctx?.ui?.setStatus?.("bash-classifier", `⏳ classifier waiting for arbiter (${why})`); } catch { /* headless */ }
      },
    });
    if (!res.ok) return { decision: "block", reason: `classifier HTTP ${res.status} ${res.code} (failing closed)` };
    return parseVerdict(res.text, CLAUDE_MODE);
  } catch (err: any) {
    return { decision: "block", reason: `classifier unavailable: ${String(err?.message || err)} (failing closed)` };
  } finally {
    try { ctx?.ui?.setStatus?.("bash-classifier", undefined); } catch { /* headless */ }
  }
}

function blocked(ctx: any, reason: string) {
  try { ctx?.ui?.notify?.(`⛔ bash blocked: ${reason}`, "warning"); } catch { /* headless */ }
  return { block: true, reason: `Blocked by local safety classifier: ${reason}` };
}

export default function registerClassifier(pi: any, secrets: Secrets) {
  pi.on("tool_call", async (event: any, ctx: any) => {
    // Fail closed on our own bugs too: an exception anywhere in the gate must
    // block the call, not let it dispatch unclassified.
    try {
      const tool = String(event?.toolName || "");
      const input = event?.input || {};

      if (READONLY) {
        if (!isReadOnlyTool(tool)) {
          return { block: true, reason: `Read-only/plan mode (PI_LOCAL_READONLY): tool "${tool}" is not on the read-only allowlist.` };
        }
        if (tool === "bash" && !fastPathSafe(String(input.command ?? ""))) {
          return { block: true, reason: "Read-only/plan mode (PI_LOCAL_READONLY): only read-only bash is allowed." };
        }
      }

      if (tool !== "bash") return;
      const command = String(input.command ?? "");
      if (!command.trim() || fastPathSafe(command)) return;

      const cwd = ctx?.cwd || process.cwd();
      const scan = scanCommand(command, cwd);
      if (scan.block) return blocked(ctx, scan.block);
      const verdict = await classify(command, cwd, scan, secrets.arbiterKey, ctx);
      if (verdict.decision === "block") return blocked(ctx, verdict.reason || "unsafe command");
      return; // ALLOW
    } catch (err: any) {
      return { block: true, reason: `classifier hook error: ${String(err?.message || err)} (failing closed)` };
    }
  });
}
