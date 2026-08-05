'use strict'

/**
 * Drift check — "your pinned skill (or your npx-cached CLI) has fallen behind".
 *
 * The asymmetry this exists for: a CLI run through `npx` is latest by construction,
 * while the skills it installs are pinned on disk ON PURPOSE and sit there until
 * somebody deliberately updates them. Weeks later the user drives current tooling
 * with stale expertise and nothing says so.
 *
 * Two properties of THIS project sharpen that:
 *
 *  - **A bare npx spec pins the CLI too.** `npx @happyskillsai/instant-canvas` reuses
 *    whatever npx cached and never re-resolves (see gotchas/packaging.md — a cache dig
 *    found 0.3.1 through 0.14.0 coexisting on one machine), and SKILL.md still teaches
 *    the bare spec to agents. So the `self` half is NOT the no-op the upstream package
 *    calls it: the version this process reports IS the pinned one.
 *  - **One version, two artifacts.** The npm package and the HappySkills skill ship on
 *    the same version but publish separately, so a user on an old skill can be driving
 *    a current CLI with a stale contract.
 *
 * The rule the whole file obeys: **a drift check must never cost the user anything.**
 * `check()` reads a cache synchronously; the refresh is fire-and-forget and every
 * failure is swallowed. A probe that breaks the command it rode in on has done more
 * damage than the staleness it was reporting.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
// Kept as the module object, never destructured: a captured `execFile` reference cannot
// be intercepted, and the probe is the one thing in here a test must be able to stand in
// for without spawning a real `npx` (~2 s a call, and a live registry).
const childProcess = require('node:child_process')

const { stateDir } = require('./paths')
const { PKG_VERSION } = require('./pkgmeta')

/** The one skill this CLI owns. Watching it (rather than everything installed) is what
 *  keeps the user's other forty skills out of a registry request they have no business
 *  being in — the upstream filter runs BEFORE the probe, not at reporting time. */
const SKILL = 'happyskillsai/instant-canvas'
const PKG_NAME = '@happyskillsai/instant-canvas'
const LOCK_FILE = 'skills-lock.json'
const GLOBAL_ROOT = () => path.join(os.homedir(), '.agents')
const CLI_TIMEOUT_MS = 8000
const DISABLE_ENV = 'INSTANTCANVAS_NO_DRIFT_CHECK'

/** `@latest` is the fix for a pinned npx cache, and it is the same seven characters the
 *  Reconnect dialog and the stopped pane already hand a human (gotchas/packaging.md). */
const SELF_UPDATE_COMMAND = `npx -y ${PKG_NAME}@latest`
const UPDATE_COMMAND = 'npx -y happyskills update'
const INSTALL_SKILL_COMMAND = 'npx -y happyskills install'

/**
 * The project root to key a scope on — NEVER the bare cwd.
 *
 * Instant Canvas is launched from any directory, frequently a subfolder. Keying the
 * cache on wherever the user happened to stand would mint a fresh scope per folder,
 * each paying its own cold start and each reporting zero installed skills because no
 * lock file lives down there. So walk up to the marker first, exactly as the upstream
 * README asks. A lock file wins over `.git`: it is the thing being read.
 *
 * The result is **realpath'd**, for the reason every other path in this project that
 * participates in identity is: on macOS `/tmp` is a symlink to `/private/tmp`, so the
 * path a user types and the path we resolve can differ — and since cache entries are
 * keyed on the root we hand over, the two spellings would become two scopes, each
 * paying its own cold start (see gotchas/runtime.md, "macOS /tmp is a symlink").
 */
function realpathSafe(p) {
	try { return fs.realpathSync(p) } catch { return p }
}

function climbTo(from, hit) {
	let cur = path.resolve(from)
	let prev = null
	while (cur && cur !== prev) {
		try { if (hit(cur)) return cur } catch { /* keep walking */ }
		prev = cur
		cur = path.dirname(cur)
	}
	return null
}

function projectRootFor(dir) {
	const lock = climbTo(dir, (c) => fs.statSync(path.join(c, LOCK_FILE)).isFile())
	if (lock) return realpathSafe(lock)
	const git = climbTo(dir, (c) => fs.statSync(path.join(c, '.git')).isDirectory())
	if (git) return realpathSafe(git)
	return realpathSafe(path.resolve(dir))
}

/**
 * A scope's installed skills, read straight out of `skills-lock.json`.
 *
 * `commit` is HappySkills' content hash for the exact ref that was installed, which is
 * precisely the "opaque revision token" the checker wants: it catches a republish that
 * reused a version string, which a version comparison cannot see.
 *
 * **A missing lock returns `{}` and never throws.** "No lock yet" means "no skills
 * installed here", which is the normal state of the global scope on a fresh machine —
 * and a scope that throws is treated as UNABLE TO REPORT, which permanently suppresses
 * the missing-skill nudge. Reserve throwing for a lock we genuinely could not read.
 */
function listInstalled({ root }) {
	let raw
	try {
		raw = fs.readFileSync(path.join(root, LOCK_FILE), 'utf8')
	} catch (err) {
		if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return {}
		throw err
	}
	const parsed = JSON.parse(raw)
	const skills = (parsed && parsed.skills) || {}
	const out = {}
	for (const [name, entry] of Object.entries(skills)) {
		if (!entry || typeof entry !== 'object') continue
		out[name] = { version: entry.version, revision: entry.commit || entry.integrity || null }
	}
	return out
}

/** Promisified `execFile` that resolves `null` on ANY failure and never holds the loop
 *  open. `unref()` is the belt-and-braces half: if the CLI is otherwise done, Node exits
 *  and the probe dies unfinished — which the cache treats as "no verdict this run", not
 *  as an all-clear. That is the correct degradation and it costs the user nothing. */
function runQuiet(cmd, args, opts) {
	return new Promise((resolve) => {
		let child
		try {
			child = childProcess.execFile(cmd, args, { ...opts, encoding: 'utf8', timeout: CLI_TIMEOUT_MS }, (err, stdout) => resolve(err ? null : stdout))
		} catch {
			return resolve(null)
		}
		try { child.unref() } catch { /* already gone */ }
	})
}

/**
 * What the registry currently has, via HappySkills' own `check` command.
 *
 * This is the same "prefer the tool that owns the file" posture `skillsconfig.js` takes
 * for `skills-config set`: HappySkills owns `skills-lock.json` and the registry behind
 * it, so we ask it rather than reimplementing a registry client. When the CLI is
 * unreachable — offline on a cold npx cache, or on Windows where a bare `npx` ENOENTs —
 * this returns nothing, the previous verdict survives untouched, and the next run
 * retries. HappySkills is never REQUIRED; its absence costs a drift check nothing.
 */
async function checkRegistry(names, ctx) {
	const scope = (ctx && ctx.id) || 'local'
	const args = ['-y', 'happyskills', 'check', '--json']
	if (scope === 'global') args.push('-g')

	const stdout = await runQuiet('npx', args, {
		cwd: scope === 'global' ? os.homedir() : (ctx && ctx.root) || process.cwd(),
		// Never inherit our stdio: the CLI's chatter would land on the agent's stdout,
		// which carries exactly one JSON document per run.
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	if (!stdout) return {}

	let parsed
	try { parsed = JSON.parse(stdout) } catch { return {} }
	const results = (parsed && parsed.data && parsed.data.results) || []
	const wanted = new Set(names.map((n) => String(n).toLowerCase()))
	const out = {}
	for (const row of results) {
		if (!row || typeof row.skill !== 'string') continue
		if (!wanted.has(row.skill.toLowerCase())) continue
		// `no-access` / `unknown` / `error` mean we could not answer — which the checker
		// must read as NO VERDICT, never as "up to date".
		const unavailable = row.status === 'no-access' || row.status === 'unknown' || row.status === 'error'
		out[row.skill] = { latest_version: row.latest || null, unavailable }
	}
	return out
}

/**
 * Invalidate the cached verdict when the lock file underneath it changed.
 *
 * Upstream asks for `invalidate()` in the ONE place that writes the lock — but we never
 * write it; HappySkills does, from a separate process we do not observe. So the change
 * is detected rather than announced: one `stat` per scope against a remembered mtime.
 * Without this, a user who ran `npx happyskills update` would keep being told to update
 * the skill they just updated, for up to a day.
 */
function invalidateOnLockChange(checker, roots) {
	const stampFile = path.join(stateDir(), 'drift-locks.json')
	let seen = {}
	try { seen = JSON.parse(fs.readFileSync(stampFile, 'utf8')) || {} } catch { /* first run, or unreadable — treat as empty */ }

	let changed = false
	for (const root of roots) {
		let mtime = 0
		try { mtime = fs.statSync(path.join(root, LOCK_FILE)).mtimeMs } catch { /* absent counts as 0 */ }
		if (seen[root] !== mtime) {
			seen[root] = mtime
			changed = true
			try { checker.invalidate(root) } catch { /* advisory by contract; never throws */ }
		}
	}
	if (!changed) return
	try {
		fs.mkdirSync(path.dirname(stampFile), { recursive: true })
		fs.writeFileSync(stampFile, JSON.stringify(seen), { mode: 0o600 })
	} catch { /* a stamp we cannot persist just means we re-invalidate next run */ }
}

let cached
/** The checker, built once per process. `null` when the feature is off or the package
 *  could not be constructed — every caller treats null as "nothing to say". */
function driftChecker(cwd = process.cwd()) {
	if (cached !== undefined) return cached
	cached = null
	try {
		const localRoot = projectRootFor(cwd)
		const globalRoot = GLOBAL_ROOT()
		const { create_checker } = require('@happyskillsai/skill-drift-check')
		const checker = create_checker({
			name: 'instant-canvas',
			// Our own state dir, not the package's `~/.config` default: this is per-machine
			// machine-managed state and the state dir is where this project's belongs
			// (the registry, the identity file and the reader's selection all live there).
			cache_dir: stateDir(),
			scopes: [
				{ id: 'local', root: () => localRoot },
				{ id: 'global', root: () => globalRoot },
			],
			list_installed: async (scope) => listInstalled(scope),
			check_registry: checkRegistry,
			watch: [SKILL],
			self: { package_name: PKG_NAME, current: PKG_VERSION },
			disabled: DISABLE_ENV,
		})
		invalidateOnLockChange(checker, [localRoot, globalRoot])
		cached = checker
	} catch { /* a drift check that breaks construction must not break the CLI */ }
	return cached
}

/**
 * Read the cached verdict and hand back the lines to print. **Synchronous, no network.**
 *
 * Returns `[]` when there is nothing to say — which is the overwhelmingly common case,
 * and the reason this can sit in front of every command.
 */
function driftLines(cwd = process.cwd()) {
	try {
		const checker = driftChecker(cwd)
		if (!checker) return []
		const verdict = checker.check()
		if (!verdict) return []
		return checker.format(verdict, {
			update_command: UPDATE_COMMAND,
			install_skill_command: INSTALL_SKILL_COMMAND,
			install_command: SELF_UPDATE_COMMAND,
			scope_flags: { global: '-g' },
		}) || []
	} catch {
		return []
	}
}

/** Reset the memoized checker. Tests only — a single-process suite would otherwise
 *  carry one process's cwd and env into every later assertion. */
function _reset() {
	cached = undefined
}

module.exports = {
	driftChecker,
	driftLines,
	listInstalled,
	checkRegistry,
	projectRootFor,
	invalidateOnLockChange,
	_reset,
	SKILL,
	PKG_NAME,
	DISABLE_ENV,
	SELF_UPDATE_COMMAND,
}
