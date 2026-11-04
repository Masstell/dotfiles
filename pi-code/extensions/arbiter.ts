// Arbiter client shared by the provider, classifier, and advisor.
//
// The arbiter is a third-party API to us (ARBITER.md in atlas is the contract):
// Bearer auth only, `model: "default"` always works, and it WAITS rather than
// fails — a request can sit for minutes while a swapped-in model is evicted or
// an image job finishes (its own budget is 600 s). So callers here get one
// helper that retries the contract's retryable codes with backoff until a
// deadline past that budget, and reports waits so the UI can say why it stalls.

export const ARBITER_URL = (process.env.PI_ARBITER_URL || "https://ai.mswensen.com").replace(/\/+$/, "");

// Just past the arbiter's own 600 s wait budget: a shorter client deadline only
// abandons requests that would have succeeded.
export const DEFAULT_DEADLINE_MS = 660_000;

// Contract §5: retry these with backoff; everything else is final.
const RETRYABLE = new Set([408, 429, 502, 503, 504]);

export type ChatResult = {
  ok: boolean;
  status: number;
  // error.code from either envelope (model_swapping, model_not_found, ...)
  code: string;
  text: string;
  // The model that actually served the request (the arbiter rewrites `model`).
  model: string;
  data: any;
};

type ChatOpts = {
  key: string;
  signal?: AbortSignal;
  deadlineMs?: number;
  // Called before each backoff sleep, e.g. to show "waiting for arbiter".
  onWait?: (why: string, attempt: number) => void;
};

function errorCode(data: any): string {
  return String(data?.error?.code || data?.error?.type || "");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error("aborted"));
    }, { once: true });
  });
}

export async function chat(body: any, opts: ChatOpts): Promise<ChatResult> {
  const deadline = Date.now() + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
  let attempt = 0;
  let last: ChatResult = { ok: false, status: 0, code: "", text: "", model: "", data: null };
  // The long deadline is for an arbiter that is busy (it answers 503/408/504).
  // One that can't be reached at all gets a minute, so a down network doesn't
  // stall every gated command for eleven minutes.
  let unreachableSince = 0;
  const UNREACHABLE_MS = 60_000;
  while (true) {
    attempt++;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ...last, ok: false, code: last.code || "deadline" };
    // One request may legitimately take most of the budget (the arbiter holds
    // it while it restores the default), so its timeout is whatever is left.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error("timeout")), remaining);
    const onAbort = () => ac.abort(opts.signal?.reason ?? new Error("aborted"));
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(`${ARBITER_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.key}` },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      let data: any = null;
      try { data = await res.json(); } catch { /* non-JSON error page */ }
      const msg = data?.choices?.[0]?.message;
      last = {
        ok: res.ok,
        status: res.status,
        code: errorCode(data),
        text: typeof msg?.content === "string" ? msg.content : "",
        model: String(data?.model || ""),
        data,
      };
      unreachableSince = 0;
      if (res.ok || !RETRYABLE.has(res.status)) return last;
      opts.onWait?.(`${res.status} ${last.code || "busy"}`, attempt);
    } catch (err: any) {
      if (opts.signal?.aborted) throw err;
      if (ac.signal.aborted) return { ...last, ok: false, code: "deadline" };
      // Connection-level failure: treat like a transient arbiter outage.
      last = { ok: false, status: 0, code: String(err?.cause?.code || err?.message || err), text: "", model: "", data: null };
      unreachableSince ||= Date.now();
      if (Date.now() - unreachableSince > UNREACHABLE_MS) return { ...last, code: `unreachable: ${last.code}` };
      opts.onWait?.(`unreachable (${last.code})`, attempt);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
    // 2, 4, 8, 15, 15, ... seconds, never past the deadline.
    const backoff = Math.min(15_000, 1000 * 2 ** attempt);
    await sleep(Math.max(0, Math.min(backoff, deadline - Date.now())), opts.signal);
  }
}

// Catalog: GET /v1/models. Best effort — callers fall back when it fails.
export async function models(key: string, timeoutMs = 4000): Promise<any[]> {
  try {
    const res = await fetch(`${ARBITER_URL}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    const data: any = await res.json();
    return Array.isArray(data?.data) ? data.data : [];
  } catch {
    return [];
  }
}
