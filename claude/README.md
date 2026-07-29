# Claude Code status line

A system-wide Claude Code status line, portable across machines via these dotfiles.

Renders:

```
~/repo  <branch> <PR/issue> ⌂<worktree>  ⚙ <subagent>  5h ▀▀▀▀▀▀▀▀ 52% 2h14m  wk ▀▀▀▀▀▀▀▀ 41% 3d11h  ctx 42%  Opus·high✳  -23 +156  ▸ <summary>
```

### Rate-limit meters

Each limit renders as one text row holding **two** stacked bars, followed by the
percent used and the time until the window resets. Every cell is a `▀` glyph, so
its **foreground** paints the upper half and its **background** the lower — that's
what lets the two bars keep separate colors even where they overlap:

| Half | Meaning | Filled | Empty |
|---|---|---|---|
| upper (fg) | percent of the limit consumed | severity: green → yellow → red | `QUOTA_OFF` gray |
| lower (bg) | how far the window has run toward reset | `CLOCK_ON` blue | `CLOCK_OFF` dark gray |

Reading the two together: a bar whose green upper half runs ahead of its blue
lower half means you're outpacing the reset clock; blue running ahead means the
window refills before you exhaust it. Width is `BAR_W` (default 8).

Labels (`5h` / `wk`) stay a neutral `LBL` gray — severity is already carried by
the bar and the percent. The countdown is `CLOCK` blue, matching the bar half it
describes. The percent is unpadded so the countdown sits one space off it; the
countdown itself is padded to 6 (`22h59m` is the widest) so its churn every few
minutes doesn't shove the following segments around.

| Segment | Source | Notes |
|---|---|---|
| directory | `workspace.current_dir` | `~`-relative |
| branch / PR / issue | git + `pr.number` + LLM-declared | LLM-declared PR wins; falls back to native PR, then a number in the branch name |
| `⌂worktree` | `workspace.git_worktree` | only inside a linked worktree |
| `⚙ subagent` | `agent.name` | only while a subagent is driving |
| `5h` / `wk` | `rate_limits.five_hour` / `seven_day` | Pro/Max only, after first API response; countdown needs `resets_at` |
| `ctx` | `context_window.used_percentage` | proximity to auto-compaction |
| model | `model.display_name` + `effort.level` + `thinking.enabled` | `✳` = thinking on |
| `-N +N` | `cost.total_lines_removed` / `total_lines_added` | hidden until something changes |
| `▸ summary` | LLM-declared via `claude-status` | ≤5 words, keyed by session id |

Usage/ctx numbers are colored bright green → yellow → red by severity (≥50% / ≥80%).

## Files

- `statusline.sh` — the status line command (reads Claude Code's stdin JSON).
- `claude-status` — helper the LLM calls to declare its focus + PR:
  `claude-status "<=5 words>" "#35"`. Writes `~/.claude/status/$CLAUDE_CODE_SESSION_ID.json`,
  so concurrent sessions in the same repo don't overwrite each other's summary.
  Files untouched for 7 days are pruned on each write.
- `CLAUDE.md` — global instruction telling the LLM to declare its summary + PR.

## Install

`install.sh` symlinks the three files into `~/.claude/` and merges the `statusLine`
config into `~/.claude/settings.json` with `jq` (idempotent — it preserves any
machine-specific settings and won't duplicate on re-run). Requires `jq` and `git`.
