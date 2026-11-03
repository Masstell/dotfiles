// web_search (Brave Search API) and web_fetch tools.
//
// web_search only registers when a Brave key is configured (BRAVE_API_KEY in
// ~/.dotfiles/.env). web_fetch needs no key; it saves the model a classified
// `curl` round trip for plain page reads and keeps the output bounded.

import { Type } from "typebox";
import type { Secrets } from "./secrets.ts";

const BRAVE_URL = "https://api.search.brave.com/res/v1/web/search";
const FETCH_MAX_CHARS = 40_000;

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|pre|section|article)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ")
    .trim();
}

export default function registerWebTools(pi: any, secrets: Secrets) {
  if (secrets.braveKey) {
    const key = secrets.braveKey;
    pi.registerTool({
      name: "web_search",
      label: "Web search",
      description:
        "Search the web (Brave Search). Returns titles, URLs and snippets; use web_fetch to read a result. " +
        "Use for current docs, error messages, release notes and anything newer than your training data.",
      promptSnippet: "Search the web for current documentation and answers",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
        count: Type.Optional(Type.Number({ description: "Results to return, 1-20 (default 8)" })),
        freshness: Type.Optional(Type.String({ description: "Limit by age: pd (day), pw (week), pm (month), py (year)" })),
      }),
      async execute(_id: string, params: any, signal: AbortSignal) {
        const count = Math.max(1, Math.min(20, Number(params.count) || 8));
        const qs = new URLSearchParams({ q: params.query, count: String(count) });
        if (params.freshness && /^p[dwmy]$/.test(params.freshness)) qs.set("freshness", params.freshness);
        const res = await fetch(`${BRAVE_URL}?${qs}`, {
          headers: { Accept: "application/json", "X-Subscription-Token": key },
          signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)].filter(Boolean)),
        });
        if (!res.ok) throw new Error(`Brave search failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
        const data: any = await res.json();
        const results = (data?.web?.results ?? []).slice(0, count);
        if (!results.length) return { content: [{ type: "text", text: `No results for: ${params.query}` }], details: { count: 0 } };
        const text = results
          .map((r: any, i: number) => `${i + 1}. ${r.title}\n   ${r.url}${r.age ? `  (${r.age})` : ""}\n   ${htmlToText(r.description || "")}`)
          .join("\n\n");
        return { content: [{ type: "text", text }], details: { count: results.length } };
      },
    });
  }

  pi.registerTool({
    name: "web_fetch",
    label: "Fetch URL",
    description:
      "GET a URL and return its readable text (HTML is converted to plain text; output capped at ~40K chars). " +
      "Read-only: no request body, no custom headers.",
    promptSnippet: "Fetch a web page as text",
    parameters: Type.Object({
      url: Type.String({ description: "http(s) URL to fetch" }),
    }),
    async execute(_id: string, params: any, signal: AbortSignal) {
      const url = new URL(params.url);
      if (!/^https?:$/.test(url.protocol)) throw new Error("only http(s) URLs are supported");
      const res = await fetch(url, {
        headers: { "User-Agent": "pi-web-fetch/1.0", Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" },
        redirect: "follow",
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)].filter(Boolean)),
      });
      const type = res.headers.get("content-type") || "";
      const body = await res.text();
      let text = /html/i.test(type) ? htmlToText(body) : body;
      const truncated = text.length > FETCH_MAX_CHARS;
      if (truncated) text = text.slice(0, FETCH_MAX_CHARS) + "\n\n[truncated]";
      return {
        content: [{ type: "text", text: `${res.status} ${res.url}\n\n${text}` }],
        details: { status: res.status, truncated },
        isError: !res.ok,
      };
    },
  });
}
