---
name: open-items
description: Session — list what is still open ranked by dependency, then ask you to decide the ones waiting on you. Use when asking what is open, what is left, what is blocking, or are we done. Not for a ledger of done plus left — that is session-status.
allowed-tools: Bash, Read, Grep, AskUserQuestion
---

# Open items

Answer one question — **what is still open?** — for a reader who is busy and impatient. The count is visible at a glance, every row says why it is not closed, and the order is the order the work must happen in. Then close the loop: for the items that are waiting on *this reader*, ask for the decision instead of leaving them to type a second prompt.

This skill never recaps completed work. `session-status` owns that — the full ledger of done, left and waiting, for someone re-orienting after time away. This one owns the impatient question asked mid-flight: **what is still open, right now.** Finished work is invisible here; only what is left appears.

## When this runs

Manually as `/open-items`, or automatically on any phrasing of the same question:

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

## Step 5 — Ask for the decisions that are yours to make

The table tells the reader what is open. It does not move anything. For the rows that are stuck **on this reader specifically**, finish the job: ask, in one batched `AskUserQuestion`, so a decision costs a click instead of a second prompt.

**Print the table first, always.** Step 4 stands on its own — a reader who ignores the question still got the full answer. Never withhold the table until the question is answered.

### Which rows earn a question

The `Blocked by` column already classifies this. Do not invent a second taxonomy.

| `Blocked by` | Ask? |
|---|---|
| `you (decide)` **and not waiting on another open row** | **Yes** — this is the whole point |
| `you (decide)` but blocked by `#N` | **No.** Its premise may evaporate once `#N` is decided — asking now buys an answer to a question that may not survive |
| `you (run it)` | No. Nothing to decide; they simply have not run it |
| `#N` | No — `#N` is the decision |
| an external name | No — it is not theirs to decide |
| `—` | No — nothing is blocking it |

**If no row qualifies, ask nothing and stop after the table.** A glance-check must not summon a modal. This is the throttle that keeps the skill usable mid-flight.

### Shape of the ask

- **One batched call, not a sequence.** `AskUserQuestion` takes up to 4 questions at once; four modals in a row is the opposite of quick.
- **Same order as the table** — most-blocking first, so the first answer is the one that unblocks the most.
- **More than four qualify?** Ask the top four and add one line under the table naming what is deferred and why: *"3 more surface once #1 lands."* Never silently drop the rest.
- **Never spend an option slot on "something else."** The tool appends a free-text **Other** choice automatically. Burning a slot to re-create it costs a real recommendation.
- Lead each question with the row it belongs to, so the modal and the table are obviously the same thing.

### What the options must be

Options are recommendations, and a wrong one that gets clicked is worse than no option at all — it turns a reporting tool into a source of bad decisions. The rule that governs rows governs options too.

- **Ground every option in something verified this turn.** If the evidence is not there, do not manufacture a path.
- **Put the recommended option first** and mark it `(Recommended)` — but only when there is a real reason to prefer it. If two paths are genuinely even, say so and do not fake a winner.
- **State the cost of each option, not just the action.** "Ship it as a patch" is a label; "ship as patch — consumers on `^1.x` auto-upgrade into the change" is a decision.
- **When you cannot responsibly recommend anything**, do not skip the row and do not invent two fake paths. Offer to lay out the trade-off: an option like *"Walk me through it"* is honest; a fabricated fork is not.

### What happens with the answers

**Record the decisions and stop. This skill does not execute them.**

Restate each answer against its row number in one line — `#1 → publish as 0.2.0` — so the decision is captured in plain sight, then end. Acting on it belongs to the session that invoked this skill, which has the answers in context and can proceed immediately. That boundary is what keeps a command you run to *check* state from becoming one that *changes* state on a mis-click.

## Constraints

- **Never** recap completed work, list what changed, or narrate the session. Rows are open items only.
- **Never** exceed two lines in a `Why` cell. Cut the reasoning, keep the consequence.
- **Never** open with a preamble ("Here's what I found...") or close with an offer ("Let me know if..."). The table, then the question, is the whole answer.
- **Never** invent an item to look thorough, and never omit one because it is awkward — a wrong count is worse than a long one.
- **Never** invent an option to look helpful. An ungrounded recommendation that gets clicked is worse than asking nothing.
- **Never** mark something closed you did not verify this turn.
- **Never** ask about a row that is not `you (decide)`, and never ask about one still blocked by another open row.
- **Never** hold back the table until the question is answered — Step 4 is complete on its own.
- **Never** write files, change state, or fix anything. This skill reports and elicits; it does not execute. `AskUserQuestion` collects a decision without mutating anything, which is why it is the only tool added — acting on the answer belongs to the session that invoked this skill.
