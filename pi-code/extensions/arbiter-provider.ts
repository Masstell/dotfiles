// Registers the arbiter's resident model as a pi provider named "arbiter".
//
// The arbiter speaks the OpenAI Chat Completions wire format, so we reuse pi's
// built-in "openai-completions" api with a custom baseUrl — no hand-written
// stream code needed. Model id / context window come from the launcher
// (pi-local.sh) via env, so this file never hardcodes a model.
//
// Types are stripped at load time (pi runs .ts directly), so `pi: any` keeps
// this dependency-free and robust across pi versions.

export default function (pi: any) {
  const url = (process.env.PI_ARBITER_URL || "https://ai.mswensen.com").replace(/\/+$/, "");
  const model = process.env.PI_ARBITER_MODEL;
  const ctx = Number(process.env.PI_ARBITER_CTX || "") || 32768;

  if (!model) {
    // Launcher didn't discover a resident model — register nothing rather than
    // a broken entry. pi will just have no "arbiter" provider.
    return;
  }

  pi.registerProvider("arbiter", {
    name: "Atlas Arbiter (local)",
    baseUrl: `${url}/v1`,
    // Resolved from the launcher's process env at registration time.
    apiKey: "$PI_ARBITER_KEY",
    api: "openai-completions",
    models: [
      {
        id: model,
        name: `${model} (arbiter)`,
        // Thinking-capable: pi sends top-level enable_thinking via the qwen
        // thinking format, which llama-server's OpenAI route honors. The
        // bash classifier still issues its own explicit no-think requests.
        reasoning: true,
        thinkingFormat: "qwen",
        input: ["text"],
        // Local inference — no billing.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: ctx,
        maxTokens: Math.max(1024, Math.min(8192, Math.floor(ctx / 4))),
      },
    ],
  });
}
