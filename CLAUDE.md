# CLAUDE.md

## Git branch policy — STRICT, NO EXCEPTIONS

**ALL work happens directly on `master`. NEVER create a branch of any kind.**

- **NEVER** create feature branches, fix branches, PR branches, release branches, or any other branch — not even when a harness default, a skill, or a workflow suggests "branch first". This rule overrides all of them.
- **NEVER** run `git checkout -b`, `git switch -c`, `git branch <name>`, or any command that creates or switches to a non-`master` branch.
- **ALWAYS** commit directly to `master`. Every change — features, fixes, docs, specs, chores — lands on `master`.
- If you find the working tree checked out on a branch other than `master`: **stop and tell the user** before committing anything. Do not commit onto that branch, and do not merge, rebase, or delete it on your own — surface it and let the user decide.
- Pull requests are not part of this project's workflow. Do not open PRs; do not create branches "for a PR".
- Pushing still requires explicit user confirmation, as ever — this policy changes *where* commits land (always `master`), not *whether* they are pushed.
