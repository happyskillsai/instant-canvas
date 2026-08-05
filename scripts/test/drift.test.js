'use strict'

/**
 * Drift check — the adapters, the invalidation, and the one rule that outranks the
 * feature: it must never cost the user anything, and it must never reach stdout.
 *
 * Every test here drives `lib/drift.js` directly with a scratch state dir. The one
 * thing deliberately NOT tested against the real network is `checkRegistry`'s happy
 * path — it spawns `npx happyskills`, which costs seconds and would make the suite
 * depend on a registry being reachable. Its PARSING is tested against recorded shapes,
 * which is the part that can actually be wrong.
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-drift-'))
process.env.INSTANTCANVAS_STATE_DIR ||= path.join(scratch, 'state')

const drift = require('../lib/drift')

function lockAt(dir, skills) {
	fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(path.join(dir, 'skills-lock.json'), JSON.stringify({ lockVersion: 2, skills }))
	return dir
}

// ---------------------------------------------------------------- listInstalled

test('listInstalled maps the lock to version + revision, and the revision is the commit', () => {
	const root = lockAt(path.join(scratch, 'ws1'), {
		'happyskillsai/instant-canvas': { version: '0.20.0', commit: 'abc123', integrity: 'sha256-zz' },
	})
	assert.deepStrictEqual(drift.listInstalled({ root }), {
		'happyskillsai/instant-canvas': { version: '0.20.0', revision: 'abc123' },
	})
})

test('listInstalled falls back to integrity when a lock entry has no commit', () => {
	const root = lockAt(path.join(scratch, 'ws-int'), { 'a/b': { version: '1.0.0', integrity: 'sha256-yy' } })
	assert.strictEqual(drift.listInstalled({ root })['a/b'].revision, 'sha256-yy')
})

test('listInstalled reports a null revision rather than inventing one', () => {
	const root = lockAt(path.join(scratch, 'ws-norev'), { 'a/b': { version: '1.0.0' } })
	assert.strictEqual(drift.listInstalled({ root })['a/b'].revision, null)
})

test('listInstalled skips a malformed entry instead of failing the whole scope', () => {
	const root = lockAt(path.join(scratch, 'ws-bad'), { 'a/b': null, 'c/d': { version: '2.0.0' } })
	const out = drift.listInstalled({ root })
	assert.ok(!('a/b' in out))
	assert.strictEqual(out['c/d'].version, '2.0.0')
})

test('a lock with no skills block is an empty scope, not a crash', () => {
	const root = path.join(scratch, 'ws-empty')
	fs.mkdirSync(root, { recursive: true })
	fs.writeFileSync(path.join(root, 'skills-lock.json'), JSON.stringify({ lockVersion: 2 }))
	assert.deepStrictEqual(drift.listInstalled({ root }), {})
})

/**
 * The one adapter rule upstream states twice, because getting it wrong is silent: a
 * scope that THROWS is treated as unable to report, and `missing` requires every scope
 * to report in — so an adapter that throws ENOENT suppresses the missing-skill nudge
 * indefinitely. A fresh machine has no global lock, which is the normal case, not an error.
 */
test('a missing lock is an EMPTY scope, never a throw — a throwing scope silences the nudge forever', () => {
	assert.deepStrictEqual(drift.listInstalled({ root: path.join(scratch, 'no-such-dir') }), {})
	// A path whose PARENT is a file yields ENOTDIR rather than ENOENT — same meaning.
	const file = path.join(scratch, 'a-file')
	fs.writeFileSync(file, 'x')
	assert.deepStrictEqual(drift.listInstalled({ root: file }), {})
})

test('an unreadable lock DOES throw — that is a real failure, not an empty scope', () => {
	const root = path.join(scratch, 'ws-corrupt')
	fs.mkdirSync(root, { recursive: true })
	fs.writeFileSync(path.join(root, 'skills-lock.json'), '{ not json')
	assert.throws(() => drift.listInstalled({ root }))
})

// ---------------------------------------------------------------- projectRootFor

test('projectRootFor walks UP to the lock file — never the bare cwd', () => {
	const root = lockAt(path.join(scratch, 'proj'), { 'a/b': { version: '1.0.0' } })
	const nested = path.join(root, 'src', 'deep', 'deeper')
	fs.mkdirSync(nested, { recursive: true })
	assert.strictEqual(drift.projectRootFor(nested), fs.realpathSync(root))
})

test('projectRootFor falls back to a .git ancestor when there is no lock yet', () => {
	const root = path.join(scratch, 'gitproj')
	fs.mkdirSync(path.join(root, '.git'), { recursive: true })
	const nested = path.join(root, 'a', 'b')
	fs.mkdirSync(nested, { recursive: true })
	assert.strictEqual(drift.projectRootFor(nested), fs.realpathSync(root))
})

/**
 * Why this matters more than it looks: cache entries are keyed on the resolved root.
 * Keying on the bare cwd would mint a separate scope for every subdirectory a user
 * happens to stand in — each paying its own cold start, and each reporting zero
 * installed skills because no lock lives down there.
 */
test('with neither marker, projectRootFor returns the directory itself rather than climbing to /', () => {
	const orphan = path.join(scratch, 'orphan', 'x')
	fs.mkdirSync(orphan, { recursive: true })
	assert.strictEqual(drift.projectRootFor(orphan), fs.realpathSync(orphan))
})

// ---------------------------------------------------------------- registry parsing

test('checkRegistry treats no-access / unknown / error as NO VERDICT, never as up-to-date', async (t) => {
	// The shape `npx happyskills check --json` really returns, recorded from a live run.
	const payload = JSON.stringify({
		data: {
			results: [
				{ skill: 'happyskillsai/instant-canvas', installed: '0.23.0', latest: '0.26.0', status: 'outdated' },
				{ skill: 'owner/denied', installed: '1.0.0', latest: null, status: 'no-access' },
				{ skill: 'owner/unrelated', installed: '1.0.0', latest: '2.0.0', status: 'outdated' },
			],
		},
	})
	t.mock.method(require('node:child_process'), 'execFile', (cmd, args, opts, cb) => {
		setImmediate(() => cb(null, payload))
		return { unref() {} }
	})
	const out = await drift.checkRegistry(['happyskillsai/instant-canvas', 'owner/denied'], { id: 'local', root: scratch })
	assert.strictEqual(out['happyskillsai/instant-canvas'].latest_version, '0.26.0')
	assert.strictEqual(out['happyskillsai/instant-canvas'].unavailable, false)
	assert.strictEqual(out['owner/denied'].unavailable, true, 'a skill we could not answer for must not read as current')
	assert.ok(!('owner/unrelated' in out), 'a row we did not ask about must not leak into the verdict')
})

test('checkRegistry matches the watch list case-insensitively — owner casing drifts in practice', async (t) => {
	const payload = JSON.stringify({ data: { results: [{ skill: 'HappySkillsAI/Instant-Canvas', installed: '1.0.0', latest: '2.0.0', status: 'outdated' }] } })
	t.mock.method(require('node:child_process'), 'execFile', (cmd, args, opts, cb) => {
		setImmediate(() => cb(null, payload))
		return { unref() {} }
	})
	const out = await drift.checkRegistry(['happyskillsai/instant-canvas'], { id: 'local', root: scratch })
	assert.strictEqual(Object.keys(out).length, 1, 'a capital letter must not make the check go quiet')
})

test('the global scope is asked with -g, and never from the workspace directory', async (t) => {
	let seen = null
	t.mock.method(require('node:child_process'), 'execFile', (cmd, args, opts, cb) => {
		seen = { cmd, args, cwd: opts.cwd }
		setImmediate(() => cb(null, '{"data":{"results":[]}}'))
		return { unref() {} }
	})
	await drift.checkRegistry(['a/b'], { id: 'global', root: '/ignored' })
	assert.ok(seen.args.includes('-g'), 'the global scope needs its own flag or it reports the local one twice')
	assert.strictEqual(seen.cwd, os.homedir())
})

/**
 * An unreachable HappySkills CLI is the NORMAL case, not an error: offline, a cold npx
 * cache, or Windows, where a bare `npx` ENOENTs. It must yield no verdict — which leaves
 * the previous one standing — rather than an exception or a false all-clear.
 */
test('an unreachable CLI yields no verdict rather than an exception', async (t) => {
	t.mock.method(require('node:child_process'), 'execFile', (cmd, args, opts, cb) => {
		setImmediate(() => cb(new Error('spawn npx ENOENT')))
		return { unref() {} }
	})
	assert.deepStrictEqual(await drift.checkRegistry(['a/b'], { id: 'local', root: scratch }), {})
})

test('a CLI that answers with garbage yields no verdict rather than a parse crash', async (t) => {
	t.mock.method(require('node:child_process'), 'execFile', (cmd, args, opts, cb) => {
		setImmediate(() => cb(null, 'not json at all'))
		return { unref() {} }
	})
	assert.deepStrictEqual(await drift.checkRegistry(['a/b'], { id: 'local', root: scratch }), {})
})

test('an execFile that THROWS synchronously is still just "no verdict"', async (t) => {
	t.mock.method(require('node:child_process'), 'execFile', () => { throw new Error('EMFILE') })
	assert.deepStrictEqual(await drift.checkRegistry(['a/b'], { id: 'local', root: scratch }), {})
})

// ---------------------------------------------------------------- invalidation

test('a changed lock file invalidates that scope — we never write the lock, so we detect it', () => {
	const root = lockAt(path.join(scratch, 'inv'), { 'a/b': { version: '1.0.0' } })
	const calls = []
	const fake = { invalidate: (r) => calls.push(r) }

	drift.invalidateOnLockChange(fake, [root])
	assert.deepStrictEqual(calls, [root], 'the first sighting counts as a change')

	drift.invalidateOnLockChange(fake, [root])
	assert.strictEqual(calls.length, 1, 'an unchanged lock must not re-invalidate on every run')

	const later = new Date(Date.now() + 10_000)
	fs.utimesSync(path.join(root, 'skills-lock.json'), later, later)
	drift.invalidateOnLockChange(fake, [root])
	assert.strictEqual(calls.length, 2, 'after `happyskills update` the cached verdict is known-wrong')
})

test('invalidation survives a checker whose invalidate throws — it is advisory by contract', () => {
	const root = lockAt(path.join(scratch, 'inv-throw'), { 'a/b': { version: '1.0.0' } })
	assert.doesNotThrow(() => drift.invalidateOnLockChange({ invalidate: () => { throw new Error('nope') } }, [root]))
})

test('a scope with no lock at all is tracked too, so INSTALLING one invalidates', () => {
	const root = path.join(scratch, 'inv-none')
	fs.mkdirSync(root, { recursive: true })
	const calls = []
	const fake = { invalidate: (r) => calls.push(r) }
	drift.invalidateOnLockChange(fake, [root])
	drift.invalidateOnLockChange(fake, [root])
	assert.strictEqual(calls.length, 1)
	lockAt(root, { 'a/b': { version: '1.0.0' } })
	drift.invalidateOnLockChange(fake, [root])
	assert.strictEqual(calls.length, 2, 'a lock appearing is a change')
})

// ---------------------------------------------------------------- the never-cost rule

test('driftLines is synchronous, returns an array, and says nothing on a cold cache', () => {
	drift._reset()
	const lines = drift.driftLines(scratch)
	assert.ok(Array.isArray(lines))
	assert.deepStrictEqual(lines, [], 'a cold cache has nothing honest to say')
})

test('the disable switch turns it off entirely', () => {
	drift._reset()
	process.env[drift.DISABLE_ENV] = '1'
	try {
		assert.deepStrictEqual(drift.driftLines(scratch), [])
		const c = drift.driftChecker(scratch)
		assert.strictEqual(c.diagnostics().disabled, true)
	} finally {
		delete process.env[drift.DISABLE_ENV]
		drift._reset()
	}
})

/** A negative assertion is vacuous unless it could have fired, so this one is paired
 *  with a checker that WOULD have produced lines had the throw not happened. */
test('a checker that throws mid-check costs the command nothing', () => {
	drift._reset()
	const real = require('@happyskillsai/skill-drift-check').create_checker
	require('@happyskillsai/skill-drift-check').create_checker = () => ({
		check: () => { throw new Error('cache corrupt') },
		format: () => ['SHOULD NEVER PRINT'],
		invalidate: () => {},
		diagnostics: () => ({}),
	})
	try {
		assert.deepStrictEqual(drift.driftLines(scratch), [], 'a broken check must be silent, not fatal')
	} finally {
		require('@happyskillsai/skill-drift-check').create_checker = real
		drift._reset()
	}
})

test('a checker that cannot even be CONSTRUCTED leaves the CLI working', () => {
	drift._reset()
	const mod = require('@happyskillsai/skill-drift-check')
	const real = mod.create_checker
	mod.create_checker = () => { throw new Error('bad config') }
	try {
		assert.strictEqual(drift.driftChecker(scratch), null)
		assert.deepStrictEqual(drift.driftLines(scratch), [])
	} finally {
		mod.create_checker = real
		drift._reset()
	}
})

test('the formatted nudge names @latest — the only thing that defeats a pinned npx cache', () => {
	drift._reset()
	const mod = require('@happyskillsai/skill-drift-check')
	const real = mod.create_checker
	let opts = null
	mod.create_checker = () => ({
		check: () => ({ self: { update_available: true, current: '0.10.0', latest: '0.26.0' } }),
		format: (v, o) => { opts = o; return ['instant-canvas 0.10.0 → 0.26.0'] },
		invalidate: () => {},
		diagnostics: () => ({}),
	})
	try {
		const lines = drift.driftLines(scratch)
		assert.strictEqual(lines.length, 1)
		assert.match(opts.install_command, /@latest$/, 'a bare npx spec reuses the cache forever; @latest is the fix')
		assert.strictEqual(opts.scope_flags.global, '-g', 'one update run writes one scope')
	} finally {
		mod.create_checker = real
		drift._reset()
	}
})

test('we watch our OWN skill only — a single-product CLI must not ship the user inventory', () => {
	assert.strictEqual(drift.SKILL, 'happyskillsai/instant-canvas')
	assert.strictEqual(drift.PKG_NAME, '@happyskillsai/instant-canvas')
})

test.after(() => {
	try { fs.rmSync(scratch, { recursive: true, force: true }) } catch { /* best effort */ }
})
