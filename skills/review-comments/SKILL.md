---
name: review-comments
description: "Resolve PR review comments one by one — read feedback from GitHub reviewers, fix or dismiss each, commit individually, then reply and resolve threads on GitHub. Use when addressing code review on a feature branch."
---

# Resolve PR Review Comments

## Quick Start

1. Load all **unresolved** review threads from the current branch's PR
2. Present numbered summary table to user
3. Process each comment: understand → validate → fix or dismiss → commit → reply → resolve thread
4. Show completion summary

## Workflow

### 1. Gather Comments

Detect the PR for the current branch and fetch all review feedback:

```bash
# Get PR metadata (need owner, repo, number)
gh pr view --json number,url,title,headRefName,baseRefName

# Get ONLY unresolved review threads via GraphQL (filter in the query to avoid huge payloads)
# Pipe through jq/python to drop resolved threads BEFORE reading the output.
# Resolved threads can contain hundreds of KB of diff hunks — never fetch them all.
gh api graphql -f owner='{owner}' -f repo='{repo}' -F number={number} -f query='
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            isOutdated
            path
            line
            startLine
            comments(first: 50) {
              nodes {
                id
                body
                author { login }
                createdAt
                diffHunk
              }
            }
          }
        }
      }
    }
  }
' | python3 -c "
import json, sys
data = json.load(sys.stdin)
threads = data['data']['repository']['pullRequest']['reviewThreads']['nodes']
unresolved = [t for t in threads if not t['isResolved']]
json.dump(unresolved, sys.stdout, indent=2)
"
```

**Why filter immediately:** The GraphQL API does not support server-side `isResolved` filtering. PRs with many resolved threads return enormous payloads (300KB+). Always pipe the output through a filter and save to a temp file (`/tmp/unresolved_threads.json`) for subsequent processing.

**Important:** Use the GraphQL `reviewThreads` query for inline comments — it returns the thread `id` (node ID) required for the reply and resolve mutations. The REST API does not expose thread node IDs.

Also fetch PR-level comments and review decisions for general (non-inline) feedback:

```bash
gh pr view --json comments
gh pr view --json reviews
```

Deduplicate across sources. Skip review entries with empty bodies (bare approve/request-changes without commentary).

If the current branch has no open PR, tell the user and stop.

### 2. Present Summary

Show a numbered table of all **unresolved** comments:

```
| # | Source     | File                | Comment (truncated)               |
|---|------------|---------------------|-----------------------------------|
| 1 | @reviewer  | src/agent/loop.py   | Consider using parameterized...   |
| 2 | Copilot    | src/api/routes.py   | This logic duplicates the...      |
| 3 | @reviewer  | (PR comment)        | Overall the approach looks...     |
```

Ask the user: **"Work on a specific comment (enter number), or start from #1?"**

### 3. Process Each Comment

For each comment, sequentially:

**a. Check for existing replies:** Before doing any work, check if the thread already has a reply from the PR author (or a previous agent run) that references a fix commit. If the comment has a reply saying "Fixed in <SHA>" but the thread was never resolved, **skip straight to resolving it** — no new commit or reply needed. Present these to the user as "already addressed, just needs resolving" and batch-resolve them (unless the user wants to review individually).

**b. Understand:** Read the full comment thread and the referenced code on the current branch. For inline comments, use the `path` and `line` fields to locate the exact code.

**c. Validate:** Is this a real issue? Research the codebase as needed — read related files, check conventions in the instruction files, understand the broader context.

**d. Act:**

- **Valid** → Apply the fix, run `make fmt` to ensure formatting, then commit individually:
  ```
  <prefix>: resolve review comment - <concise summary>
  ```
  Use conventional commit prefixes: `fix:`, `refactor:`, `style:`, `perf:`, `docs:`, `test:`, `chore:`, etc.

- **Invalid / Not applicable** → Explain specifically why the comment doesn't apply (reference actual code, conventions, or architectural decisions). **Ask the user to confirm dismissal before skipping.** Never dismiss silently.

**e. Reply & Resolve on GitHub (always together):**

**Always reply and resolve in the same step** — never leave a thread replied-to but unresolved. Run both mutations back-to-back immediately after committing a fix or confirming a dismissal:

```bash
# Reply (fixed)
gh api graphql -f threadId='<THREAD_NODE_ID>' \
  -f body='Fixed in <SHORT_SHA>: <one-line summary of the change>' \
  -f query='
    mutation($threadId: ID!, $body: String!) {
      addPullRequestReviewThreadReply(input: {
        pullRequestReviewThreadId: $threadId, body: $body
      }) { comment { id } }
    }'

# Reply (dismissed — user confirmed skip)
gh api graphql -f threadId='<THREAD_NODE_ID>' \
  -f body='Skipped: <concise reason why this does not apply>' \
  -f query='
    mutation($threadId: ID!, $body: String!) {
      addPullRequestReviewThreadReply(input: {
        pullRequestReviewThreadId: $threadId, body: $body
      }) { comment { id } }
    }'

# Resolve — ALWAYS run immediately after the reply, same step, no exceptions
gh api graphql -f threadId='<THREAD_NODE_ID>' -f query='
  mutation($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { isResolved }
    }
  }'
```

**f. Confirm:** "Comment #N resolved. Moving to #N+1..."

### 4. Completion Summary

After all comments are processed:

```
✓ All N review comments processed:
  - N applied (committed individually)
  - N dismissed (with confirmation)
  - All threads replied to and resolved on GitHub
```

Remind the user to:
- Run `make test` to verify everything passes (if not done during fixes)
- `git push` when ready

## Guardrails

- **One commit per comment** — never batch multiple resolutions into a single commit
- **Never dismiss without user confirmation** — always explain why and wait for approval
- **Do not squash, amend, or rebase** commits created during this workflow
- **NEVER push to `master`** — pushing is only allowed on feature branches (`feature/*`, `fix/*`, `refactor/*`, `docs/*`, `chore/*`). Verify the current branch before any `git push`
- **Reply to every processed thread** — fixed or dismissed, always leave a reply before resolving
- **Always resolve immediately after replying** — reply + resolve are one atomic step, never separated. This prevents orphaned "replied but unresolved" threads
- **Run `make fmt`** before each commit to ensure Atlas formatting compliance
- **Atlas conventions** — when validating comments, reference `.github/copilot-instructions.md` and `CLAUDE.md` for project conventions before deciding if a comment is valid
