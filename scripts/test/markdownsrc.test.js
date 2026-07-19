'use strict'

// The kernel-side half of the markdown "src" allowlist. The validator guards the
// CLI path; this guards the path a canvas takes when it reaches the kernel without
// ever having been validated. Both must refuse to read `.env`.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { hasMarkdownExtension, readMarkdownSrc, stripFrontmatter, inlineLocalImages, inlineMath } = require('../lib/markdownsrc')

// The smallest valid PNG: 1x1, transparent.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

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

test('stripFrontmatter removes a leading YAML block and nothing else', () => {
	assert.equal(stripFrontmatter('---\ntitle: x\n---\n# Body\n'), '# Body\n')
	assert.equal(stripFrontmatter('---\r\ntitle: x\r\n---\r\n# Body\n'), '# Body\n')
	// A thematic break is not frontmatter, and neither is an unterminated fence.
	assert.equal(stripFrontmatter('# Hi\n\n---\n\nrule above\n'), '# Hi\n\n---\n\nrule above\n')
	assert.equal(stripFrontmatter('---\nunterminated\n# body\n'), '---\nunterminated\n# body\n')
	assert.equal(stripFrontmatter('no frontmatter'), 'no frontmatter')
})

test('readMarkdownSrc strips frontmatter for every markdown extension', () => {
	const root = workspace()
	// A Jekyll/Hugo/Obsidian .md carries frontmatter too; rendered as plain markdown
	// it becomes a rule plus a setext heading of the raw keys.
	const doc = '---\ntitle: Report\n---\n# Body\n'
	for (const name of ['a.mdx', 'a.md', 'a.markdown']) {
		fs.writeFileSync(path.join(root, name), doc)
		assert.equal(readMarkdownSrc(root, name, MAX), '# Body\n', `${name}: frontmatter is metadata, not prose`)
	}

	// A document that merely CONTAINS a thematic break keeps it.
	const rule = '# Hi\n\n---\n\nrule above\n'
	fs.writeFileSync(path.join(root, 'rule.md'), rule)
	assert.equal(readMarkdownSrc(root, 'rule.md', MAX), rule)
})

test('inlineLocalImages turns a workspace image into a data: URI', () => {
	const root = workspace()
	fs.writeFileSync(path.join(root, 'logo.png'), PNG)
	fs.mkdirSync(path.join(root, 'assets'))
	fs.writeFileSync(path.join(root, 'assets', 'deep.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')

	const out = inlineLocalImages('![a](logo.png)', root, root, MAX)
	assert.match(out, /^!\[a\]\(data:image\/png;base64,[A-Za-z0-9+/=]+\)$/)
	assert.ok(out.includes(PNG.toString('base64')), 'the bytes are the file\'s bytes')

	// MIME comes from the extension; a title survives the rewrite.
	assert.match(inlineLocalImages('![](assets/deep.svg "cap")', root, root, MAX), /data:image\/svg\+xml;base64,.* "cap"\)/)

	// A src file's images resolve relative to that file's directory.
	assert.match(inlineLocalImages('![](deep.svg)', root, path.join(root, 'assets'), MAX), /data:image\/svg\+xml/)
})

test('inlineLocalImages degrades to a label, never a broken image', () => {
	const root = workspace()
	const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-out-')))
	fs.writeFileSync(path.join(outside, 'leak.png'), PNG)
	fs.writeFileSync(path.join(root, 'big.png'), PNG)
	fs.writeFileSync(path.join(root, 'notes.txt'), 'x')

	assert.equal(inlineLocalImages('![](gone.png)', root, root, MAX), '*(image unavailable: gone.png)*')
	assert.equal(inlineLocalImages('![](big.png)', root, root, 4), '*(image unavailable: big.png)*')
	assert.equal(inlineLocalImages('![](notes.txt)', root, root, MAX), '*(image unavailable: notes.txt)*')
	assert.equal(inlineLocalImages('![](../oops.png)', root, root, MAX), '*(image unavailable: ../oops.png)*')

	// Confinement holds through an absolute path and a symlink.
	fs.symlinkSync(path.join(outside, 'leak.png'), path.join(root, 'link.png'))
	assert.doesNotMatch(inlineLocalImages('![](link.png)', root, root, MAX), /data:/)
	assert.doesNotMatch(inlineLocalImages(`![](${path.join(outside, 'leak.png')})`, root, root, MAX), /data:/)
})

test('inlineLocalImages leaves remote, data:, and quoted references alone', () => {
	const root = workspace()
	fs.writeFileSync(path.join(root, 'logo.png'), PNG)

	// Remote is the validator's job (REMOTE_ASSET_BLOCKED); do not rewrite it here.
	const remote = '![a](https://cdn.example.com/a.png)'
	assert.equal(inlineLocalImages(remote, root, root, MAX), remote)

	const already = '![a](data:image/png;base64,AAAA)'
	assert.equal(inlineLocalImages(already, root, root, MAX), already)

	// A fenced example documents the syntax; it is not an image to inline.
	const fenced = '```md\n![a](logo.png)\n```\n'
	assert.equal(inlineLocalImages(fenced, root, root, MAX), fenced)
	assert.equal(inlineLocalImages('Use `![a](logo.png)` inline.', root, root, MAX), 'Use `![a](logo.png)` inline.')
})

test('readMarkdownSrc degrades to a labeled fallback, never a throw', () => {
	const root = workspace()
	assert.match(readMarkdownSrc(root, 'gone.md', MAX), /not found: gone\.md/)

	fs.mkdirSync(path.join(root, 'dir.md'))
	assert.equal(readMarkdownSrc(root, 'dir.md', MAX), '*(markdown source unavailable)*')

	fs.writeFileSync(path.join(root, 'big.md'), 'x'.repeat(64))
	assert.equal(readMarkdownSrc(root, 'big.md', 32), '*(markdown source unavailable)*')
})

// ------------------------------------------------------------------ inlineMath
//
// The server-side math pass. It replaces $…$ / $$…$$ / \(…\) / \[…\] with an
// inert PUA+base64 sentinel the browser re-expands (the client `math` core rule,
// asserted for real in render.test.js). Here we decode the sentinel and check the
// grammar: delimiters, price guards, code exclusion, and the bad-TeX error path.

// The sentinel's Private-Use-Area delimiters (never NUL — see the app.js gotcha).
const MS = String.fromCharCode(0xE000), MU = String.fromCharCode(0xE001), ME = String.fromCharCode(0xE002)
const SENTINEL_RE = new RegExp(MS + '([ibe])' + MU + '([\\s\\S]*?)' + ME, 'g')

// Decode every sentinel in an inlineMath output into a plain object.
function sentinels(out) {
	const list = []
	for (const m of out.matchAll(SENTINEL_RE)) {
		const f = m[2].split(MU)
		if (m[1] === 'e')
			list.push({ mode: 'error', source: Buffer.from(f[0], 'base64').toString('utf8'), message: Buffer.from(f[1], 'base64').toString('utf8') })
		else
			list.push({ mode: m[1], bucket: Number(f[0]), svg: Buffer.from(f[1], 'base64').toString('utf8'), tex: Buffer.from(f[2], 'base64').toString('utf8') })
	}
	return list
}

test('inlineMath recognizes all four delimiter forms', () => {
	const s = sentinels(inlineMath('a $x^2$ b \\(y\\) c $$z$$ d \\[w\\] e'))
	assert.deepEqual(s.map((m) => [m.mode, m.tex]), [
		['i', 'x^2'], ['i', 'y'], ['b', 'z'], ['b', 'w'],
	])
})

test('inlineMath renders each span to a CSP-clean inline svg', () => {
	const [m] = sentinels(inlineMath('area $\\int_0^\\infty e^{-x^2}dx$ here'))
	assert.equal(m.mode, 'i')
	assert.equal(/style\s*=/.test(m.svg), false, 'svg carries no inline style')
	assert.match(m.svg, /currentColor/)
	assert.match(m.svg, /<path\b/)
	assert.ok(m.bucket > 0, 'a descending formula gets a non-zero baseline bucket')
})

test('inlineMath skips prices and escaped dollars', () => {
	const out = inlineMath('it costs $5 today and \\$10 tomorrow and 100$ later')
	assert.equal(sentinels(out).length, 0, 'no formula from prices')
	assert.ok(out.includes('$5 today'), 'the price text is left literal')
})

test('inlineMath does not fire inside fenced or inline code', () => {
	const fenced = '```\n$x$ stays literal\n```\n'
	assert.equal(inlineMath(fenced), fenced)
	assert.equal(inlineMath('use `$y$` inline'), 'use `$y$` inline')
})

test('inlineMath matches display before inline, so $$ is never two empty $…$', () => {
	const s = sentinels(inlineMath('$$a+b$$'))
	assert.equal(s.length, 1)
	assert.equal(s[0].mode, 'b')
	assert.equal(s[0].tex, 'a+b')
})

test('inlineMath emits an error sentinel for bad LaTeX, keeping the source and message', () => {
	const [m] = sentinels(inlineMath('bad $\\notacommand$ ok'))
	assert.equal(m.mode, 'error')
	assert.equal(m.source, '\\notacommand')
	assert.match(m.message, /Undefined control sequence/)
})

test('inlineMath is a no-op (and loads no engine) when there is no math', () => {
	const plain = 'plain prose, a price $ sign alone, no closing.'
	assert.equal(inlineMath('no math here at all'), 'no math here at all')
	// A lone $ with no valid pair is left untouched.
	assert.equal(inlineMath(plain), plain)
})
