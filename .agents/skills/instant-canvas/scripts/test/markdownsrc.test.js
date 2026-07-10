'use strict'

// The kernel-side half of the markdown "src" allowlist. The validator guards the
// CLI path; this guards the path a canvas takes when it reaches the kernel without
// ever having been validated. Both must refuse to read `.env`.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { hasMarkdownExtension, readMarkdownSrc } = require('../lib/markdownsrc')

const MAX = 2 * 1024 * 1024
const SECRET = 'SECRET=hunter2'

function workspace() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-mdsrc-')))
	fs.writeFileSync(path.join(root, '.env'), SECRET)
	fs.writeFileSync(path.join(root, 'notes.md'), '# Notes')
	return root
}

test('hasMarkdownExtension accepts the allowlist case-insensitively and nothing else', () => {
	for (const ok of ['a.md', 'a.mdx', 'a.markdown', 'A.MD', 'deep/path/B.MdX'])
		assert.equal(hasMarkdownExtension(ok), true, ok)
	for (const no of ['.env', 'id_rsa', 'a.txt', 'a.md.txt', 'a.json', 'mdx', 'a.md/../.env'])
		assert.equal(hasMarkdownExtension(no), false, no)
})

test('readMarkdownSrc reads a markdown file inside the root', () => {
	const root = workspace()
	assert.equal(readMarkdownSrc(root, 'notes.md', MAX), '# Notes')
})

test('readMarkdownSrc never reads a non-markdown file, even inside the root', () => {
	const root = workspace()
	for (const src of ['.env', 'notes.md/../.env']) {
		const out = readMarkdownSrc(root, src, MAX)
		assert.doesNotMatch(out, /hunter2/, `${src} must not be read`)
		assert.equal(out, '*(markdown source unavailable)*')
	}
})

test('readMarkdownSrc never reads outside the root', () => {
	const root = workspace()
	const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-outside-')))
	fs.writeFileSync(path.join(outside, 'leak.md'), 'leaked')

	assert.equal(readMarkdownSrc(root, path.join(outside, 'leak.md'), MAX), '*(markdown source unavailable)*')
	assert.equal(readMarkdownSrc(root, '../ic-outside-nope/leak.md', MAX), '*(markdown source unavailable)*')

	// Symlink escape: insideRoot realpaths, so the link is not a way around it.
	fs.symlinkSync(path.join(outside, 'leak.md'), path.join(root, 'link.md'))
	assert.equal(readMarkdownSrc(root, 'link.md', MAX), '*(markdown source unavailable)*')
})

test('readMarkdownSrc degrades to a labeled fallback, never a throw', () => {
	const root = workspace()
	assert.match(readMarkdownSrc(root, 'gone.md', MAX), /not found: gone\.md/)

	fs.mkdirSync(path.join(root, 'dir.md'))
	assert.equal(readMarkdownSrc(root, 'dir.md', MAX), '*(markdown source unavailable)*')

	fs.writeFileSync(path.join(root, 'big.md'), 'x'.repeat(64))
	assert.equal(readMarkdownSrc(root, 'big.md', 32), '*(markdown source unavailable)*')
})
