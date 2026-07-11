'use strict'

// The kernel-side half of the markdown "src" allowlist. The validator guards the
// CLI path; this guards the path a canvas takes when it reaches the kernel without
// ever having been validated. Both must refuse to read `.env`.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { hasMarkdownExtension, readMarkdownSrc, stripFrontmatter, inlineLocalImages } = require('../lib/markdownsrc')

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
