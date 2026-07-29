#!/usr/bin/env bash
# System-wide Claude Code status line.
# Renders:  <dir>  <branch> <PR/issue>  <model>  5h <n>% · 7d <n>%  ▸ <declared summary>
#
# Native data comes from the JSON on stdin (Claude Code >= 2.1.x).
# The summary + PR are whatever the LLM last declared via ~/.claude/bin/claude-status.

input="$(cat)"

j() { printf '%s' "$input" | jq -r "$1" 2>/dev/null; }

CDIR="$(j '.workspace.current_dir // .cwd // empty')"
MODEL="$(j '.model.display_name // empty')"
SID="$(j '.session_id // "nosession"')"
FIVE="$(j '.rate_limits.five_hour.used_percentage // empty')"
WEEK="$(j '.rate_limits.seven_day.used_percentage // empty')"
FIVE_RESET="$(j '.rate_limits.five_hour.resets_at // empty')"
WEEK_RESET="$(j '.rate_limits.seven_day.resets_at // empty')"
PR_NATIVE="$(j '.pr.number // empty')"
EFFORT="$(j '.effort.level // empty')"
THINK="$(j '.thinking.enabled // empty')"
CTX="$(j '.context_window.used_percentage // empty')"
LINES_ADD="$(j '.cost.total_lines_added // empty')"
LINES_DEL="$(j '.cost.total_lines_removed // empty')"
AGENT="$(j '.agent.name // empty')"
WORKTREE="$(j '.workspace.git_worktree // empty')"

# ---- colors (literal ESC bytes so we can echo plainly) ----
ESC=$'\033['
R=$'\033[0m'
DIM=$'\033[2m'
CYAN=$'\033[36m'
MAG=$'\033[35m'
YEL=$'\033[33m'
GRN=$'\033[32m'
RED=$'\033[31m'
BLU=$'\033[34m'
GRAY=$'\033[38;5;245m'
LBL=$'\033[38;5;250m'        # meter labels (5h / wk) — neutral; severity lives in the bar
CLOCK=$'\033[38;5;39m'       # reset countdown text
QUOTA_OFF=$'\033[38;5;240m'  # upper half: quota not yet consumed
CLOCK_ON=$'\033[48;5;32m'    # lower half: window elapsed
CLOCK_OFF=$'\033[48;5;236m'  # lower half: not yet elapsed

# ---- directory (~ for $HOME) ----
DIR_DISP="$CDIR"
case "$CDIR" in
  "$HOME")   DIR_DISP="~" ;;
  "$HOME"/*) DIR_DISP="~${CDIR#"$HOME"}" ;;
esac

# ---- git branch (cached 5s per session to avoid slow git in big repos) ----
CACHE="/tmp/cc-statusline-${SID}"
if [ -f "$CACHE" ] && [ $(( $(date +%s) - $(stat -c %Y "$CACHE" 2>/dev/null || echo 0) )) -lt 5 ]; then
  BRANCH="$(cat "$CACHE" 2>/dev/null)"
else
  BRANCH=""
  [ -n "$CDIR" ] && BRANCH="$(git -C "$CDIR" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  printf '%s' "$BRANCH" > "$CACHE" 2>/dev/null
fi

# ---- LLM-declared summary + PR (keyed by session id, so concurrent sessions in the
# same repo don't clobber each other's summary) ----
SFILE="$HOME/.claude/status/$SID.json"
SUMMARY=""
PR_DECL=""
if [ -f "$SFILE" ]; then
  SUMMARY="$(jq -r '.summary // empty' "$SFILE" 2>/dev/null)"
  PR_DECL="$(jq -r '.pr // empty' "$SFILE" 2>/dev/null)"
fi

# PR/issue: prefer what the LLM declared, else native pr.number, else a number in the branch.
REF="$PR_DECL"
if [ -z "$REF" ] && [ -n "$PR_NATIVE" ]; then REF="#$PR_NATIVE"; fi
if [ -z "$REF" ] && [ -n "$BRANCH" ]; then
  num="$(printf '%s' "$BRANCH" | grep -oE '[0-9]+' | head -1)"
  [ -n "$num" ] && REF="#$num"
fi

# ---- usage color by severity (bright variants — meters read poorly in dim) ----
uclr() { awk -v p="$1" 'BEGIN{ if (p>=80) print "91"; else if (p>=50) print "93"; else print "92" }'; }

# ---- rate-limit meters ----
# Each meter stacks two independent bars inside one row of text. Every cell is a
# ▀ glyph, so its foreground paints the upper half and its background the lower:
#   upper half = percent of the limit consumed  (green → yellow → red by severity)
#   lower half = how far the window has run toward its reset  (blue)
# That's what lets both bars keep their own color even where they overlap.
BAR_W=8
NOW="$(date +%s)"

# meter <used_pct> <window_elapsed_pct>
meter() {
  local uc tc i out="" clr fg bg
  uc="$(awk -v p="$1" -v w="$BAR_W" 'BEGIN{c=int(p*w/100+0.5); if(c<0)c=0; if(c>w)c=w; print c}')"
  tc="$(awk -v p="$2" -v w="$BAR_W" 'BEGIN{c=int(p*w/100+0.5); if(c<0)c=0; if(c>w)c=w; print c}')"
  clr="${ESC}$(uclr "$1")m"
  for ((i = 1; i <= BAR_W; i++)); do
    if [ "$i" -le "$uc" ]; then fg="$clr";      else fg="$QUOTA_OFF"; fi
    if [ "$i" -le "$tc" ]; then bg="$CLOCK_ON"; else bg="$CLOCK_OFF"; fi
    out="$out${fg}${bg}▀${R}"
  done
  printf '%s' "$out"
}

# elapsed <resets_at> <window_secs> — how far through the window we are, 0-100
elapsed() {
  awk -v r="$1" -v w="$2" -v n="$NOW" 'BEGIN{
    if (r <= 0 || w <= 0) { print 0; exit }
    p = (n - (r - w)) / w * 100
    if (p < 0) p = 0; if (p > 100) p = 100
    printf "%.2f", p
  }'
}

# countdown <seconds> — 6d5h / 5h42m / 42m
countdown() {
  awk -v s="$1" 'BEGIN{
    if (s < 0) s = 0
    d = int(s/86400); s -= d*86400
    h = int(s/3600);  s -= h*3600
    m = int(s/60)
    if (d > 0)      printf "%dd%dh", d, h
    else if (h > 0) printf "%dh%02dm", h, m
    else if (m > 0) printf "%dm", m
    else            printf "<1m"
  }'
}

# limit_seg <label> <used_pct> <resets_at> <window_secs>
#   "5h ▀▀▀▀▀▀▀▀ 23% 42m"
# The percent is unpadded so the countdown sits one space off it. The countdown IS
# padded — it changes width every few minutes, and the pad keeps that churn from
# shoving the following segments around.
limit_seg() {
  local label="$1" pct="$2" reset="$3" win="$4"
  local seg clr
  clr="${ESC}$(uclr "$pct")m"
  seg="${LBL}${label}${R} $(meter "$pct" "$(elapsed "${reset:-0}" "$win")")"
  seg="$seg $(printf '%s%.0f%%%s' "$clr" "$pct" "$R")"
  [ -n "$reset" ] && seg="$seg $(printf '%s%-6s%s' "$CLOCK" "$(countdown $((reset - NOW)))" "$R")"
  printf '%s' "$seg"
}

# ---- assemble segments ----
out=""
add() { [ -n "$1" ] && out="${out:+$out  }$1"; }

add "${CYAN}${DIR_DISP}${R}"

gitseg=""
[ -n "$BRANCH" ] && gitseg="${MAG}${BRANCH}${R}"
[ -n "$REF" ] && gitseg="${gitseg:+$gitseg }${YEL}${REF}${R}"
[ -n "$WORKTREE" ] && gitseg="${gitseg:+$gitseg }${DIM}⌂${WORKTREE}${R}"
add "$gitseg"

# active subagent (present only while a subagent is driving)
[ -n "$AGENT" ] && add "${BLU}⚙ ${AGENT}${R}"

# usage limits + context window, clustered with tight single-space separators
stats=""
sadd() { [ -n "$1" ] && stats="${stats:+$stats  }$1"; }
[ -n "$FIVE" ] && sadd "$(limit_seg 5h "$FIVE" "$FIVE_RESET" 18000)"
[ -n "$WEEK" ] && sadd "$(limit_seg wk "$WEEK" "$WEEK_RESET" 604800)"
# context-window usage (how close to auto-compaction); high = bad, so reuse uclr
if [ -n "$CTX" ]; then
  cc="$(uclr "$CTX")"; c="$(printf '%.0f' "$CTX")"
  sadd "${ESC}${cc}mctx ${c}%${R}"
fi
add "$stats"

# model, with effort level and a ✳ thinking marker appended
mseg=""
if [ -n "$MODEL" ]; then
  mseg="$MODEL"
  [ -n "$EFFORT" ] && mseg="$mseg·$EFFORT"
  [ "$THINK" = "true" ] && mseg="$mseg✳"
  mseg="${GRAY}${mseg}${R}"
fi
add "$mseg"

# lines changed this session (skip when nothing has changed yet)
if [ "${LINES_ADD:-0}" != "0" ] || [ "${LINES_DEL:-0}" != "0" ]; then
  lseg=""
  [ -n "$LINES_DEL" ] && lseg="${RED}-${LINES_DEL}${R}"
  [ -n "$LINES_ADD" ] && lseg="${lseg:+$lseg }${GRN}+${LINES_ADD}${R}"
  add "$lseg"
fi

[ -n "$SUMMARY" ] && add "${DIM}▸${R} $SUMMARY"

printf '%s' "$out"
