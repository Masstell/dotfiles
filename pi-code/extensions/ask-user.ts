// ask_user: the model stops and asks you a question, with choices and an
// "other" answer you type, instead of guessing. Headless runs (pi -p,
// subagents) get told nobody is there to answer, so the model decides itself
// and says what it assumed.

import { Type } from "typebox";

const OTHER = "Other (type an answer)";

export default function registerAskUser(pi: any) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask user",
    description:
      "Ask the user a question and wait for the answer. Offer 2-5 concrete choices; the user can also type their own answer.",
    promptSnippet: "Ask the user a question with choices when a decision is theirs to make",
    promptGuidelines: [
      "Use ask_user when a decision is genuinely the user's (a trade-off, a preference, missing requirements) and a wrong guess would waste work. Don't ask what you can find out by reading the code or trying it.",
      "Put the recommended choice first. Ask one question at a time.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      question: Type.String({ description: "The question, standing on its own" }),
      choices: Type.Array(Type.String(), { description: "2-5 short answers; the recommended one first", minItems: 1, maxItems: 6 }),
      context: Type.Optional(Type.String({ description: "One or two lines of background shown with the question" })),
    }),
    async execute(_id: string, params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      const question = String(params.question || "").trim();
      const choices = (Array.isArray(params.choices) ? params.choices : []).map((c: any) => String(c).trim()).filter(Boolean).slice(0, 6);
      if (!ctx?.hasUI) {
        return {
          content: [{ type: "text", text: "No one can answer right now (non-interactive run). Make the most reasonable choice yourself and state the assumption in your answer." }],
          details: { question, answer: null },
        };
      }
      const title = params.context ? `${question}\n${String(params.context).trim()}` : question;
      const picked = await ctx.ui.select(title, [...choices, OTHER]);
      let answer: string | undefined = picked;
      let typed = false;
      if (picked === OTHER) {
        answer = await ctx.ui.input(question, "");
        typed = true;
      }
      if (!answer || !String(answer).trim()) {
        return { content: [{ type: "text", text: "The user dismissed the question without answering. Don't ask again right away: stop and wait for their next message." }], details: { question, answer: null } };
      }
      return {
        content: [{ type: "text", text: `The user answered: ${String(answer).trim()}` }],
        details: { question, answer: String(answer).trim(), typed },
      };
    },
  });
}
