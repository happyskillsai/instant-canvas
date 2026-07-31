---
name: print-open-items
description: Session — print only the still-open items, ranked by dependency, under a headline count. Use when asking what is open, what is left, what is blocking, or are we done. Not for a ledger of done plus left — that is session-status.
allowed-tools: Bash, Read, Grep
---

# Print open items

Answer one question — **what is still open?** — for a reader who is busy and impatient. The count is visible at a glance, every row says why it is not closed, and the order is the order the work must happen in.

This skill never recaps completed work. `session-status` owns that — the full ledger of done, left and waiting, for someone re-orienting after time away. This one owns the impatient question asked mid-flight: **what is still open, right now.** Finished work is invisible here; only what is left appears.

## When this runs

Manually as `/print-open-items`, or automatically on any phrasing of the same question:

> "any open items?" · "what's left?" · "what's still open?" · "are we done?" · "are we waiting on anything?" · "anything blocking?" · "what's outstanding?" · "is this finished?"

If the user names a scope ("open items on the release"), restrict the list to it and say so in the headline. Otherwise, cover the whole session.

## Step 1 — Verify, never recite

**Do not build the list from memory.** Memory reports what you intended, and the gap between intended and actual is precisely what an open item is. Check the world first — cheaply, in parallel, read-only.

Run what applies to this session. This list is a prompt for thinking, not a script to execute blindly:

| Check | Why it finds open items |
|---|---|
| `git status --short` | Uncommitted work that was described as done |
| `git log <remote>/<branch>..HEAD --oneline` | Commits made but never pushed |
| `git ls-remote --tags origin` vs local tags | A release tagged locally and not published |
| `ps` for processes this session started | Servers, watchers, background jobs still running |
| Re-run or re-read the last test/build result | A failing test left behind is open, however small |
| Artifacts written but not applied | A migration, config or script authored and never run |

Then re-read the conversation for the two sources no command can see:

- **Questions you asked that were never answered.** Every one is open, including ones you proceeded past under an assumption — say which assumption shipped.
- **Work the user took ownership of.** "I'll publish it myself", "leave that with me" — theirs to do, still not done, therefore still open.

An item you cannot verify is reported as unverified, never as done.

## Step 2 — Decide what counts

**Open** — anything that must happen before the session's own goal is met:

- Work started and not finished
- A handoff to the user that has not been performed
- An unanswered question or an unconfirmed assumption already shipped
- A known failure, regression or skipped check left in place
- Something waiting on an external party, a build, or a review

**Not open** — leave these out entirely:

- Anything finished and verified — its absence is the point
- Improvements nobody asked for, refactors you would enjoy, general tech debt
- Risks with no action attached to them

Padding the table with speculative work destroys the thing that makes it useful: that the count is trustworthy at a glance.

## Step 3 — Order by dependency

Sort so that doing item 1 unblocks item 2. Rules, in order:

1. **Hard dependency wins.** If B cannot start until A is done, A comes first.
2. **Cheap decisions that gate expensive work come first** — an unanswered question blocking a publish outranks the publish.
3. **Cost of delay breaks ties.** Prefer whatever gets more expensive the longer it waits.
4. Independent items keep their natural order at the end.

## Step 4 — Print it

Exactly this shape. No preamble, no restatement of the question, no closing offer of help.

```
**N open** — <one short clause of texture, only when it earns its place>

| # | Item | Why it's still open | Blocked by |
|---|------|---------------------|------------|
| 1 | <2-5 words> | <max 2 lines, ends with the consequence or the cost> | you (decide) |
| 2 | <2-5 words> | <max 2 lines> | #1 |

*Clear: <what was verified done, in one line>*
```

Rules for each part:

- **The count is the first thing on the page.** A number in bold, then at most one clause explaining its shape ("2 need you, 1 is downstream"). Drop the clause when the number speaks for itself.
- **Item** is a name, not a sentence — the reader scans this column.
- **Why it's still open** is at most two lines and answers *why it is not closed*, never *what it is*. Where it matters, end on the consequence of leaving it ("after publish this costs a patch release").
- **Blocked by** carries one of: `#N` (another row), `you (decide)`, `you (run it)`, an external name, or `—` when nothing blocks it and it is simply not done.
- **Clear** is one line naming what you actually verified as done, so the reader can trust the absence of rows. Omit it if you verified nothing.

When everything is closed, print exactly:

```
**0 open** — done.

*Clear: <the verified list>*
```

## Constraints

- **Never** recap completed work, list what changed, or narrate the session. Rows are open items only.
- **Never** exceed two lines in a `Why` cell. Cut the reasoning, keep the consequence.
- **Never** open with a preamble ("Here's what I found...") or close with an offer ("Let me know if..."). The table is the whole answer.
- **Never** invent an item to look thorough, and never omit one because it is awkward — a wrong count is worse than a long one.
- **Never** mark something closed you did not verify this turn.
- **Never** write files, change state, or fix anything while reporting. This skill is read-only. If the user wants an item actioned, that is a separate request.
