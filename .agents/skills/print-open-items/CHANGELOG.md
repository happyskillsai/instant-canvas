# Changelog

## [0.1.1] - 2026-07-31

### Changed
- Sharpened the description so routing against `nicolasdao/session-status` is deterministic. Both skills answer to "what is left", which made the phrase ambiguous wherever the Essentials kit installs the pair. The negative slot now names session-status explicitly, and SKILL.md states the split: session-status is the full ledger for someone re-orienting after time away, this is the impatient mid-flight question of what is still open.

## [0.1.0] - 2026-07-31

### Added
- Initial release. Prints only the still-open items of a session: a headline count on its own line, then a table of `# | Item | Why it's still open | Blocked by`, ordered so each item unblocks the next, and a closing line naming what was verified clear.
- Auto-invokes on the natural phrasings of the question — "any open items?", "what's left?", "are we done?", "anything blocking?" — as well as the explicit `/print-open-items`.
- Verifies state before reporting (working tree, unpushed commits, unpublished tags, processes still running, last test result) rather than reciting from memory, and treats unanswered questions and user-owned handoffs as open items in their own right.
- Read-only by construction: `allowed-tools` carries no `Write` or `Edit`, so reporting can never mutate the thing being reported on.
