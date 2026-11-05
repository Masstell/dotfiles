// Keys for the arbiter and Brave, and the memory, routine and folder-grant signing keys, read once at startup.
//
// The sandbox launcher (pi.sh) hands them over on an inherited file descriptor
// (PI_SECRETS_FD), not the environment: anything pi runs could read pi's
// environment back out of /proc/<pid>/environ, but once this closes the
// descriptor, nothing started afterwards (every bash command) can reach them.
// Outside the sandbox (eval, PI_NOSANDBOX) plain env vars still work.

import { closeSync, readFileSync } from "node:fs";

export type Secrets = { arbiterKey: string; braveKey: string; memoryKey: string; routineKey: string; grantKey: string };

// Survive /reload: the descriptor is gone after the first read, so the parsed
// keys live on globalThis rather than in this module's (re-evaluated) scope.
const STASH = Symbol.for("homelab.pi.secrets");

function parse(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export function readSecrets(): Secrets {
  const g = globalThis as any;
  if (g[STASH]) return g[STASH];
  let vars: Record<string, string> = {};
  const fd = Number(process.env.PI_SECRETS_FD || "");
  if (Number.isInteger(fd) && fd > 2) {
    try {
      vars = parse(readFileSync(fd, "utf8"));
    } catch { /* already closed or never passed: fall through to env */ }
    try { closeSync(fd); } catch { /* ignore */ }
    delete process.env.PI_SECRETS_FD;
  }
  const secrets: Secrets = {
    arbiterKey: vars.PI_ARBITER_KEY || process.env.PI_ARBITER_KEY || "",
    braveKey: vars.BRAVE_API_KEY || process.env.BRAVE_API_KEY || "",
    // Signs project-memory notes (memory.ts). Never taken from the
    // environment: bash inherits that, and could then forge notes.
    memoryKey: vars.PI_MEMORY_KEY || "",
    // Signs routines (routines-core.ts) the same way; the runner verifies
    // them with the same key, read from its file outside the sandbox.
    routineKey: vars.PI_ROUTINE_KEY || "",
    // Signs folder-access requests (folders.ts) that pi.sh acts on.
    grantKey: vars.PI_GRANT_KEY || "",
  };
  g[STASH] = secrets;
  return secrets;
}
