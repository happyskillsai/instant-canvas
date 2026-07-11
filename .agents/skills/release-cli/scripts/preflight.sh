#!/bin/sh
# Release pre-flight gates for the instant-canvas CLI (Modes A/B).
# Runs from anywhere inside the repo; everything resolves from the git root.
# Exits non-zero on the first failing gate with the fix named. Order is
# cheap-first: clean tree, docs sync, tests, coverage gate.

ROOT="$(git rev-parse --show-toplevel)" || exit 2
cd "$ROOT" || exit 2

# Gate 0 — clean working tree. Hard gate: the release commits only release
# metadata, so releasing over uncommitted work would tag a commit that does
# not contain the changes it ships.
DIRTY="$(git status --porcelain)"
if [ -n "$DIRTY" ]; then
	echo "Cannot release — uncommitted changes:" >&2
	echo "" >&2
	echo "$DIRTY" >&2
	echo "" >&2
	echo "The release only commits package.json, the skill bundle's skill.json," >&2
	echo "and CHANGELOG.md. It does NOT commit your feature or fix code, so" >&2
	echo "releasing now would produce a tag that does not contain the changes" >&2
	echo "it ships. Commit your changes first, then re-run the release." >&2
	exit 1
fi

# Gate 1 — docs manifest in sync (warn-and-continue when the gate cannot run).
GEN=".claude/skills/init-doc/scripts/build-doc-manifest.py"
if command -v python3 >/dev/null 2>&1 && [ -f "$GEN" ]; then
	python3 "$GEN" --root "$ROOT" --check
	CODE=$?
	if [ "$CODE" -eq 1 ]; then
		echo "Docs drifted from the code — run /update-doc, commit, then re-run the release." >&2
		exit 1
	elif [ "$CODE" -ne 0 ]; then
		echo "Docs manifest structural problem (exit $CODE) — fix the docs corpus before releasing." >&2
		exit 1
	fi
else
	echo "warn: python3 or the doc-manifest generator is unavailable — docs-sync gate skipped." >&2
fi

# Gate 2 — the full suite (~80 s; browser tests self-skip without Chrome).
npm test || { echo "Tests failed — fix them before releasing." >&2; exit 1; }

# Gate 3 — the enforced CLI coverage gate (~80 s).
npm run coverage:cli || { echo "The CLI coverage gate failed — restore coverage before releasing." >&2; exit 1; }

echo "All release gates passed."
