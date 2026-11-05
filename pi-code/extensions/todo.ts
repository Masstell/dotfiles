// Task checklist: the todo_write tool keeps a visible list of the steps of the
// current task, shown above the editor and ticked off as pi works (Claude
// Code's TodoWrite). Local models lose the thread of long, multi-step work
// more easily; writing the plan down and updating it keeps them on it, and
// shows you where it is.
//
// The list lives in the tool results (details), so it follows the session:
// /tree, /fork, /resume and /reload all show the list as of that point.

import { Type } from "typebox";

export const STATUSES = ["pending", "in_progress", "completed"] as const;
export type Todo = { content: string; status: (typeof STATUSES)[number] };
export const MAX_TODOS = 30;
const ITEM_CHARS = 200;
const WIDGET = "homelab-todo";

const text = (t: string, details: unknown, isError = false) => ({
  content: [{ type: "text", text: t }], details, ...(isError ? { isError: true } : {}),
});

/** Check a proposed list; the reason it's refused, or "". */
export function problems(todos: unknown): string {
  if (!Array.isArray(todos)) return "todos must be a list";
  if (todos.length > MAX_TODOS) return `at most ${MAX_TODOS} items; group smaller steps`;
  for (const [i, t] of todos.entries()) {
    if (!t || typeof t !== "object") return `item ${i + 1} is not an object`;
    if (typeof (t as any).content !== "string" || !(t as any).content.trim()) return `item ${i + 1} has no content`;
    if (!STATUSES.includes((t as any).status)) return `item ${i + 1}: status must be one of ${STATUSES.join(", ")}`;
  }
  if (todos.filter((t: any) => t.status === "in_progress").length > 1) return "only one item can be in_progress at a time";
  return "";
}

const MARK: Record<Todo["status"], string> = { pending: "☐", in_progress: "◐", completed: "☑" };

export function render(todos: Todo[]): string[] {
  const done = todos.filter((t) => t.status === "completed").length;
  return [`Tasks ${done}/${todos.length}`, ...todos.map((t) => `${MARK[t.status]} ${t.content}`)];
}

/** The list as of the current branch: the last todo_write result on it. */
export function fromBranch(entries: any[]): Todo[] {
  let todos: Todo[] = [];
  for (const e of entries) {
    if (e?.type === "message" && e.message?.role === "toolResult" && e.message.toolName === "todo_write" && !e.message.isError) {
      const t = e.message.details?.todos;
      if (Array.isArray(t)) todos = t;
    }
  }
  return todos;
}

export default function registerTodo(pi: any) {
  let todos: Todo[] = [];

  const show = (ctx: any) => {
    if (!ctx?.hasUI) return;
    // A finished list stays until the next task replaces it, but folds to one line.
    const open = todos.some((t) => t.status !== "completed");
    ctx.ui.setWidget(WIDGET, !todos.length ? undefined : open ? render(todos) : [`Tasks ${todos.length}/${todos.length} done`]);
  };
  const reload = (ctx: any) => {
    try { todos = fromBranch(ctx.sessionManager.getBranch()); } catch { todos = []; }
    show(ctx);
  };
  pi.on("session_start", async (_e: any, ctx: any) => reload(ctx));
  pi.on("session_tree", async (_e: any, ctx: any) => reload(ctx));

  pi.registerTool({
    name: "todo_write",
    label: "Tasks",
    description:
      "Write the task list for the current work: the whole list each time, each item pending, in_progress or completed. " +
      "The owner sees it above the input. Use it for work with 3 or more steps, or when the owner gives several things to do.",
    promptSnippet: "Track the steps of multi-step work in a visible task list",
    promptGuidelines: [
      "For a task with 3 or more distinct steps, call todo_write first with the steps, then keep it current as you work.",
      "Exactly one item is in_progress while you work on it; mark it completed as soon as it's done (not in batches at the end), then start the next.",
      "Only mark an item completed when it is fully done: tests pass, nothing left half-finished. If you hit a blocker, keep it in_progress and add an item for the blocker.",
      "Skip the list for a single small change or a question.",
    ],
    parameters: Type.Object({
      todos: Type.Array(Type.Object({
        content: Type.String({ description: "The step, as an imperative: 'Add a --dry-run flag'" }),
        status: Type.Union(STATUSES.map((s) => Type.Literal(s))),
      }), { description: "The complete list, in order" }),
    }),
    async execute(_id: string, p: any, _signal: any, _onUpdate: any, ctx: any) {
      const why = problems(p?.todos);
      if (why) return text(`Task list not changed: ${why}.`, { todos }, true);
      todos = (p.todos as Todo[]).map((t) => ({ content: t.content.trim().replace(/\s+/g, " ").slice(0, ITEM_CHARS), status: t.status }));
      show(ctx);
      const left = todos.filter((t) => t.status !== "completed");
      const now = todos.find((t) => t.status === "in_progress");
      return text(
        !todos.length ? "Task list cleared."
          : !left.length ? `All ${todos.length} tasks completed.`
          : `Task list updated: ${todos.length - left.length}/${todos.length} done.` +
            (now ? ` Working on: ${now.content}.` : " Nothing in_progress: mark the next item in_progress when you start it."),
        { todos },
      );
    },
  });

  pi.registerCommand("todos", {
    description: "Show the current task list",
    handler: async (_args: string, ctx: any) => {
      ctx.ui.notify(todos.length ? render(todos).join("\n") : "No task list in this session.", "info");
    },
  });
}
