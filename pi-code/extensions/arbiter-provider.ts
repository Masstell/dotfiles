// Registers the arbiter as pi provider "arbiter" with one model, "default".
//
// The arbiter contract reserves `default` for "whatever the operator's default
// model is right now", and a standard key is always served by it no matter
// what `model` says — so there is nothing to discover before opening. The only
// thing read from the catalog is the context window, best effort, because the
// contract says to size compaction against the allocated n_ctx.

import { ARBITER_URL, models } from "./arbiter.ts";
import type { Secrets } from "./secrets.ts";

const FALLBACK_CTX = 32768;

// The catalog does not mark which entry is the default, and `loaded` may
// briefly be a model a swap key brought in. The loaded entry is still the best
// guess almost all of the time; PI_ARBITER_CTX overrides it.
async function contextWindow(key: string): Promise<number> {
  const forced = Number(process.env.PI_ARBITER_CTX || "");
  if (forced > 0) return forced;
  const catalog = await models(key);
  const loaded = catalog.find((m) => m?.status?.value === "loaded");
  const n = Number(loaded?.meta?.n_ctx || "");
  return n > 0 ? n : FALLBACK_CTX;
}

export default async function registerArbiter(pi: any, secrets: Secrets) {
  if (!secrets.arbiterKey) return; // no key: register nothing rather than a broken provider
  const ctx = await contextWindow(secrets.arbiterKey);
  const key = secrets.arbiterKey;
  pi.registerProvider("arbiter", {
    name: "Arbiter (local GPU)",
    baseUrl: `${ARBITER_URL}/v1`,
    // A literal, not "$ENV": the key never enters pi's environment (secrets.ts).
    apiKey: key,
    api: "openai-completions",
    models: [
      {
        id: "default",
        name: "arbiter default",
        // The default is a reasoning model. The contract's switch is
        // chat_template_kwargs.enable_thinking on the OpenAI route.
        reasoning: true,
        compat: { thinkingFormat: "qwen-chat-template" },
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: ctx,
        maxTokens: Math.max(4096, Math.min(16384, Math.floor(ctx / 4))),
      },
    ],
  });
}
