// Offline tests for extensions/memory-core.ts: recall picks the right note
// (and stays quiet when nothing fits), write checks reject secrets and
// near-duplicates, archive/restore round-trips, the index respects its cap,
// and the slug matches pi.sh. No model calls. Run: ./memory-eval.sh

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  LIMITS, archiveNote, buildIndex, checkCandidate, loadNotes, recall, restoreNote, slug, writeNote,
} from "../extensions/memory-core.ts";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memeval-"));
const today = "2026-11-04";
const seed = [
  { name: "deploy-needs-vpn", description: "Deploys to staging fail unless the WireGuard tunnel is up", keywords: ["deploy", "staging", "wireguard", "vpn", "ssh timeout"], type: "project",
    body: "The staging host is only reachable over WireGuard. A deploy that hangs at ssh means wg0 is down; bring it up with wg-quick up wg0." },
  { name: "migrations-alembic", description: "Database migrations use alembic, run inside the api container", keywords: ["migrations", "alembic", "database", "schema"], type: "project",
    body: "Run `docker compose exec api alembic upgrade head`. Never edit an applied migration; add a new revision." },
  { name: "user-prefers-vim", description: "The user edits with vim, never suggest nano", keywords: ["editor", "vim", "nano"], type: "user",
    body: "Give vim commands when the user needs to edit a file by hand." },
  { name: "tests-need-redis", description: "Integration tests need a local redis on 6380", keywords: ["tests", "pytest", "redis", "integration"], type: "project",
    body: "Start it with `docker run -p 6380:6379 redis:7`; the default 6379 is taken by the cache." },
];
for (const s of seed) writeNote(dir, { ...s, source: "agent", updated: today });
const notes = loadNotes(dir);
check("loads all seeded notes", notes.length === seed.length, `${notes.length}`);

// --- Recall ---
const want: [string, string | null][] = [
  ["the deploy to staging hangs at ssh, any idea?", "deploy-needs-vpn"],
  ["can you check the wireguard config", "deploy-needs-vpn"],
  ["add a migration for the new orders table with alembic", "migrations-alembic"],
  ["the database schema needs a new column", "migrations-alembic"],
  ["pytest integration tests fail with connection refused", "tests-need-redis"],
  ["how do I open this file in an editor", "user-prefers-vim"],
  // Restraint: nothing should come back for unrelated work.
  ["add a dark mode toggle to the settings page", null],
  ["rename the variable foo to bar", null],
  ["what's the weather like", null],
  ["hi", null],
];
for (const [q, expect] of want) {
  const hits = recall(q, notes);
  const top = hits[0]?.note.name ?? null;
  check(`recall: "${q}" -> ${expect ?? "(nothing)"}`, expect === null ? hits.length === 0 : top === expect,
    `got ${hits.map((h) => `${h.note.name}:${h.score.toFixed(2)}[${h.matched.join(",")}]`).join(" ") || "nothing"}`);
}
const skip = new Set([`deploy-needs-vpn@${today}`]);
check("recall skips notes already recalled this session", !recall("staging deploy hangs at ssh", notes, skip).some((h) => h.note.name === "deploy-needs-vpn"));
check("recall returns at most the limit", recall("deploy staging migrations alembic tests redis vim editor", notes).length <= LIMITS.recallNotes);

// --- Write checks ---
const base = { name: "new-note", description: "Something new about the build cache", keywords: ["build", "cache"], type: "project", content: "The build cache lives in .cache/build." };
check("accepts a normal note", checkCandidate(base, notes) === undefined, checkCandidate(base, notes));
const rejects: [string, any, RegExp][] = [
  ["bad name", { ...base, name: "New Note!" }, /kebab/],
  ["multi-line description", { ...base, description: "a\nb" }, /one line/],
  ["unknown type", { ...base, type: "misc" }, /type must be/],
  ["too long", { ...base, content: "x".repeat(LIMITS.bodyChars + 1) }, /under/],
  ["sk- key", { ...base, content: "use key sk-abcdefghijklmnop1234567890" }, /API key/],
  ["github token", { ...base, content: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789" }, /GitHub/],
  ["private key", { ...base, content: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc" }, /private key/],
  ["credential assignment", { ...base, content: "set password=hunter2hunter2 in the env" }, /credential/],
  ["long opaque token", { ...base, content: "the bearer is Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1ub3A" }, /token-like/],
  ["near-duplicate of deploy note", { ...base, name: "staging-wireguard", description: "Deploys to staging fail unless the WireGuard tunnel is up", keywords: ["deploy", "staging", "wireguard", "vpn"] }, /deploy-needs-vpn/],
];
for (const [label, cand, re] of rejects) {
  const err = checkCandidate(cand, notes) || "";
  check(`rejects ${label}`, re.test(err), err || "accepted");
}
check("updating an existing name is not a duplicate", checkCandidate({ ...base, name: "deploy-needs-vpn", description: "Deploys to staging fail unless the WireGuard tunnel is up", keywords: ["deploy"] }, notes) === undefined);
check("allows paths and short hashes", checkCandidate({ ...base, content: "Fixed in a1b2c3d; see src/build/cache_manager_for_the_whole_project.py" }, notes) === undefined,
  checkCandidate({ ...base, content: "Fixed in a1b2c3d; see src/build/cache_manager_for_the_whole_project.py" }, notes));

// --- Archive / restore / update ---
writeNote(dir, { ...seed[2], source: "agent", updated: today, body: "Updated: vim, with the user's own vimrc." });
check("update archives the previous version", fs.readdirSync(path.join(dir, "archive")).some((f) => f.startsWith("user-prefers-vim.")));
check("archiveNote removes the live note", !!archiveNote(dir, "tests-need-redis") && !fs.existsSync(path.join(dir, "tests-need-redis.md")));
check("restoreNote brings it back", restoreNote(dir, "tests-need-redis") && fs.existsSync(path.join(dir, "tests-need-redis.md")));
check("archive is not loaded as notes", loadNotes(dir).length === seed.length);

// --- Index ---
const idx = buildIndex(dir, loadNotes(dir));
check("index lists every note", seed.every((s) => idx.includes(`- ${s.name}:`)));
check("index says notes are hints, not instructions", /not instructions/.test(idx));
const many = Array.from({ length: 400 }, (_, i) => ({ ...loadNotes(dir)[0], name: `note-${i}`, description: "x".repeat(120) }));
const big = buildIndex(dir, many);
check("index respects its cap", big.length <= LIMITS.indexChars + 200, `${big.length}`);
check("index reports what it dropped", /older notes not listed/.test(big));
check("empty memory gives no index", buildIndex(dir, []) === "");

// --- Slug matches pi.sh ---
const piSh = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "pi.sh");
const fn = fs.readFileSync(piSh, "utf8").match(/memory_slug\(\) \{[\s\S]*?\n\}/)?.[0] || "";
for (const p of ["/home/matt/projects/my.app", "/home/matt/" + "deep/".repeat(60) + "x"]) {
  let sh = "";
  try { sh = execFileSync("bash", ["-c", `${fn}\nmemory_slug "$1"`, "_", p], { encoding: "utf8" }); } catch (e: any) { sh = `error: ${e.message}`; }
  check(`slug matches pi.sh (${p.length} chars)`, !!fn && sh === slug(p), `ts=${slug(p).slice(0, 40)}… sh=${sh.slice(0, 40)}…`);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`----\npass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
