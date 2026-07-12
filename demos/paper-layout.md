# Paper Layout Demo

This file exists to be looked at **twice**: once in the continuous view, and once
as paper (the deck toggle in the topbar, or the print button). Everything below
behaves differently in the two, on purpose — a screen has scrollbars and a
clipboard, and paper has neither.

## 1. A table that fits

Nothing to fix here, and that is the point: this table keeps its natural, compact
layout on paper. It is *not* stretched across the sheet.

| Kind | Blocks | Latency (ms) | Share |
|:-----|-------:|-------------:|------:|
| markdown | 1 | 0.42 | 12.5 % |
| chart | 26 | 18.90 | 61.0 % |
| table | 1 | 1.10 | 9.25 % |
| form | 16 | 3.75 | 17.25 % |

## 2. A table far too wide for the page

Eleven columns. **On screen** it scrolls sideways inside its own box — drag it, or
shift-scroll, and you reach `version` at the far right.

**On paper** there is nowhere to scroll to. This used to print with seven and a
half columns: `ws_clients`, `idle_seconds` and `version` were simply *absent from
the PDF*, with no ellipsis and nothing to say they had ever existed. Now the table
folds its cells instead, so every column survives — cramped, but complete.

| id | workspace_key | pid | port | token_prefix | started_at | last_activity | ws_clients | pending_sessions | idle_seconds | version |
|---:|---|---:|---:|---|---|---|---:|---:|---:|---|
| 1 | `a3f9c2e1b7d40856` | 48213 | 51877 | `k9Qw…` | 2026-07-10T04:11:02Z | 2026-07-10T05:19:44Z | 2 | 0 | 41 | 0.2.1 |
| 2 | `77bd10ee4c2af993` | 48990 | 52014 | `Zx1p…` | 2026-07-10T04:52:19Z | 2026-07-10T05:20:01Z | 1 | 1 | 3 | 0.2.1 |
| 3 | `c04ba71f9d2e6a18` | 49317 | 52088 | `Pm7t…` | 2026-07-10T06:02:55Z | 2026-07-10T06:03:10Z | 0 | 0 | 902 | 0.3.2 |

## 3. A code line far too wide for the page

Same story, smaller stakes: on screen this fence scrolls, and printed it used to be
sliced off at the right edge mid-token. It now wraps. The second line is a URL with
no natural break in it anywhere — that is the case `break-word` alone cannot fold.

```js
const result = await Promise.all(blocks.map(async (block, index) => renderBlock(block, { index, theme, palette, root, token, signal, retries: 3, deadlineMs: 30000 })))
const endpoint = 'https://example.com/a/very/long/path/that/keeps/going/and/going/without/any/convenient/break/opportunity?token=abcdefghijklmnopqrstuvwxyz0123456789'
```

Note the copy button on that fence **on screen**, and its absence on paper: nobody
copies a PDF to the clipboard.

## 4. Vertical rhythm

Every heading on this page has real space above and below it. In the deck that was
not true until recently — each markdown element becomes its own fragment, which
made every one of them both the first *and* the last child of its wrapper, and the
margin reset zeroed both. Paper printed with its headings glued to the prose while
the screen looked perfect.

### A third-level heading

Prose under it, to show the spacing is deliberate rather than accidental.

### Another one

And a fenced block that merely *quotes* markup, which must survive untouched —
it is prose about HTML, not HTML:

```html
<details><summary>keep me exactly as written</summary></details>
```

## What to look for

1. Open this file — you are in the **continuous** view. The wide table scrolls; the
   long code line scrolls; each fence has a copy button.
2. Hit the **deck** toggle in the topbar. Now it is paper: the wide table folds to
   fit, the code wraps, the copy buttons are gone, and the headings breathe.
3. Hit the **print** button (or `⌘P`). What you see on the sheets is what lands in
   the PDF, 1:1 — including every one of those eleven columns.
