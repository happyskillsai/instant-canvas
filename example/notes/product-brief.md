---
title: Atlas Launch Brief
owner: nic@cloudlesslabs.com
status: draft
---

# Atlas Launch Brief

> **TL;DR** — Atlas is our fake product for testing InstantCanvas document rendering: headings, tables, task lists, and highlighted code all live in this file.

## Problem

Teams answer the same data questions by rebuilding dashboards nobody maintains. By the time the panel ships, the question has changed.

## Approach

1. The agent wrangles the data.
2. The canvas renders it — *disposable by default*.
3. Nothing is hosted, nothing phones home.

### Milestones

- [x] Contract frozen (26 chart kinds)
- [x] Validator returns teaching errors
- [ ] Beta cohort onboarded
- [ ] Pricing page live

## Rollout metrics

| Cohort | Users | Activation | Week-4 retention |
|:-------|------:|-----------:|-----------------:|
| Alpha  |    18 |      72.2% |            61.1% |
| Beta 1 |   140 |      64.3% |            52.9% |
| Beta 2 |   410 |      58.8% |              TBD |

## Integration sample

```js
const { execFileSync } = require('node:child_process')
const result = JSON.parse(execFileSync('npx', [
	'-y', '@happyskillsai/instant-canvas', 'open', 'report.canvas.json'
]))
console.log(result.status) // "opened"
```

```sql
-- weekly activation by cohort
SELECT cohort, date_trunc('week', activated_at) AS week, count(*) AS n
FROM signups
WHERE activated_at IS NOT NULL
GROUP BY 1, 2
ORDER BY 2;
```

See the [changelog](#) for what shipped last sprint.
