'use strict'

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { onPath } = require('./reveal')

// Put a local image in front of a chat app, in the fewest gestures the OS allows.
//
// WHY THIS SHAPE, because the obvious one does not exist. A chat app's URL scheme
// carries TEXT and nothing else: `whatsapp://send` accepts `phone` and `text`, and
// there is no media parameter in any of them, documented or otherwise. WhatsApp has
// exactly three media ingress paths — the OS share sheet, its own file picker, and
// the Business Cloud API — and a URL is not one of them. macOS closes the first of
// those too: WhatsApp registers no `com.apple.share-services` extension, so it never
// appears in the system share sheet and `navigator.share({files})` cannot reach it.
// `open -a WhatsApp <file>` is a no-op (its Info.plist claims `public.image`, but
// LaunchServices does not honour the claim — inherited Catalyst metadata).
//
// What is left, and what is VERIFIED working, is the clipboard: an image placed on
// the pasteboard pastes into a WhatsApp or Telegram chat as an attachment, with a
// preview-then-send confirmation rather than an immediate send. So the flow is
// "copy, open the app, the reader presses paste" — one click and one keystroke.
//
// Sibling of lib/reveal.js, built on the same shape: pick a cmd + argv per platform,
// spawn, swallow the failure, return a boolean. It inherits that file's two rules and
// adds two of its own.
//
//   - NEVER build a shell string. A file named `; rm -rf ~` is a legal name on macOS
//     and Linux, so a path is always ONE argv entry handed to spawn(). There is no
//     exec, no execSync and no shell:true anywhere in this file. The rule EXTENDS to
//     the script text we hand an interpreter: the AppleScript below reads its path out
//     of `argv` and the PowerShell reads it out of the environment, because a path
//     interpolated into a script body is a shell string wearing a different hat.
//   - The path is NOT validated here. Confinement is the caller's job (the kernel's
//     /api/share route runs insideRoot + lstat + the image-extension gate before we
//     are reached), and two copies of a security check are two copies that drift.
//   - The clipboard write must COMPLETE before the app is opened, or the reader is
//     looking at a chat window while the bytes are still in flight. So `copyImage` is
//     awaited (bounded by a timeout) while the app launch stays fire-and-forget, the
//     way every opener in reveal.js is.
//   - We hand over a TEMP COPY, never the reader's original. WhatsApp for Mac has an
//     open bug where a dragged file is MOVED into its container rather than copied,
//     which loses the original if the message is later deleted. Nothing here drags,
//     but the same instinct applies to anything we point a chat app at: the file the
//     app sees is ours to lose, not theirs.

/** How long a clipboard write may take before we give up and report failure. */
const COPY_TIMEOUT_MS = 15000

/**
 * Run a command to completion and resolve true iff it exited 0. Bounded by a timeout,
 * because this one is AWAITED on the request path — an interpreter that hangs would
 * hang the route with it, and a share that never answers is worse than one that fails.
 */
function run(cmd, args, { timeoutMs = COPY_TIMEOUT_MS, env, stdin } = {}) {
	return new Promise((resolve) => {
		let child
		try {
			child = spawn(cmd, args, {
				stdio: [stdin ? 'pipe' : 'ignore', 'ignore', 'ignore'],
				windowsHide: true,
				...(env ? { env } : {}),
			})
		} catch {
			return resolve(false)
		}
		let settled = false
		const finish = (ok) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			resolve(ok)
		}
		const timer = setTimeout(() => {
			try { child.kill() } catch { /* already gone */ }
			finish(false)
		}, timeoutMs)
		child.on('error', () => finish(false))
		child.on('close', (code) => finish(code === 0))
		if (stdin) {
			// A read stream, piped in. An EPIPE here means the child died first, which
			// the close handler already reports — swallow it rather than throwing async.
			stdin.on('error', () => finish(false))
			child.stdin.on('error', () => { /* reported by close */ })
			stdin.pipe(child.stdin)
		}
	})
}

/** Fire-and-forget launch, identical in shape to reveal.js's. True iff spawn did not throw. */
function launch(cmd, args) {
	try {
		const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true })
		child.on('error', () => { /* swallowed — the caller already reported what it could */ })
		child.unref()
		return true
	} catch {
		return false
	}
}

// ------------------------------------------------------------------ the clipboard

/**
 * AppleScript that reads a path from `argv` and puts the file's bytes on the pasteboard
 * as a PNG. Split across -e lines exactly as `osascript` wants them, and the path is
 * NEVER interpolated: `item 1 of argv` is what keeps a filename containing a quote from
 * closing the string and running as script.
 */
const OSA_COPY_PNG = [
	'-e', 'on run argv',
	'-e', 'set the clipboard to (read (POSIX file (item 1 of argv)) as «class PNGf»)',
	'-e', 'end run',
]

/**
 * PowerShell that reads the path out of the ENVIRONMENT and puts the image on the
 * clipboard. Two details are load-bearing:
 *   - `-STA`: System.Windows.Forms.Clipboard requires a single-threaded apartment, and
 *     PowerShell 7 defaults to MTA, where the call fails outright.
 *   - FromStream over a byte copy, not FromFile: FromFile holds a lock on the file for
 *     the lifetime of the Bitmap, and we are pointing at a file in the reader's own
 *     workspace.
 */
const PS_COPY_IMAGE = [
	'Add-Type -AssemblyName System.Windows.Forms, System.Drawing;',
	'$b = [System.IO.File]::ReadAllBytes($env:IC_SHARE_PATH);',
	'$s = New-Object System.IO.MemoryStream(,$b);',
	'$img = [System.Drawing.Image]::FromStream($s);',
	'[System.Windows.Forms.Clipboard]::SetImage($img);',
	'$img.Dispose(); $s.Dispose();',
].join(' ')

/** Wayland first, then X11. Each is probed on PATH before it is spawned. */
const LINUX_CLIPBOARD = ['wl-copy', 'xclip']

/**
 * Copy `abs` (an absolute path to an image file) onto the system clipboard as image
 * DATA — not a file reference. Resolves true iff the bytes landed.
 *
 * Image data rather than a file reference is a deliberate, evidence-backed choice.
 * Pasting image data into a chat is documented and verified; pasting a file REFERENCE
 * (what the file manager's own Copy produces) is not documented by WhatsApp anywhere,
 * for any file type — its help pages describe exactly two attach mechanisms, the
 * paperclip and drag-and-drop. That is also why this function refuses video and audio
 * rather than pretending: there is no "video bytes on the pasteboard" flavour on any of
 * the three platforms, so the only clipboard representation of an .mp4 is a reference,
 * and a reference is the thing we cannot show works. Callers fall back to reveal.
 *
 * `mime` is used only on Linux, where the clipboard is typed and the tools take the
 * type verbatim; macOS and Windows re-encode through the OS image APIs.
 */
async function copyImage(abs, mime) {
	if (process.platform === 'darwin')
		return copyImageDarwin(abs)

	if (process.platform === 'win32')
		return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', PS_COPY_IMAGE], {
			env: { ...process.env, IC_SHARE_PATH: abs },
		})

	if (headless())
		return false

	const type = mime || 'image/png'
	for (const tool of LINUX_CLIPBOARD) {
		if (!onPath(tool))
			continue
		// wl-copy reads the payload from stdin and takes the type as a flag; xclip takes
		// both the type and the file as argv. Either way the PATH is an argv entry or a
		// pipe, never text inside a command.
		if (tool === 'wl-copy')
			return run('wl-copy', ['--type', type], { stdin: fs.createReadStream(abs) })
		return run('xclip', ['-selection', 'clipboard', '-t', type, '-i', abs])
	}
	return false
}

/**
 * macOS: convert to PNG with `sips`, then read the PNG onto the pasteboard.
 *
 * The conversion is not cosmetic. AppleScript's `read … as «class PNGf»` is a coercion
 * of the file's ACTUAL bytes, so it only succeeds on a file that is already a PNG —
 * pointing it at a .jpg fails. Normalising through `sips` (stock on every macOS, no
 * Homebrew, no compiler) makes one code path serve every image kind, and it is what
 * produces the rich pasteboard the chat apps read from: PNG, AVIF, GIF, JPEG, TIFF,
 * BMP and more, all offered at once, so the receiving app picks whatever it prefers.
 *
 * The temp file is ours and is always removed: the pasteboard holds the BYTES after the
 * read, not a reference, so nothing downstream depends on the file surviving.
 */
async function copyImageDarwin(abs) {
	const tmp = path.join(os.tmpdir(), `ic-share-${crypto.randomBytes(8).toString('hex')}.png`)
	try {
		if (!(await run('sips', ['-s', 'format', 'png', abs, '--out', tmp])))
			return false
		return await run('osascript', [...OSA_COPY_PNG, '--', tmp])
	} finally {
		try { fs.unlinkSync(tmp) } catch { /* never written, or already gone */ }
	}
}

// ------------------------------------------------------------------ the chat apps

/** True when a graphical session looks absent — the same heuristic reveal.js uses. */
const headless = () => !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY

/**
 * The deep link for a target, given the reader's own config. Returns null when the
 * platform has no native app to link to and the caller should fall back to the web.
 *
 * `phone`/`user` are already strictly validated by lib/sharecfg.js — digits only, and a
 * Telegram username charset — which is what lets them be concatenated here at all. They
 * reach an OS-level URL handler, so an unvalidated value would be an injection sink in
 * exactly the way lib/appearance.js's mode enum is.
 */
function chatUrl(target, cfg = {}) {
	if (target === 'whatsapp')
		// No phone: open the app and let the reader pick a chat. WITH a phone — their own
		// number — this lands directly in the "Message Yourself" chat, which is what turns
		// "save this for myself" into a single click.
		return cfg.whatsappPhone ? `whatsapp://send?phone=${cfg.whatsappPhone}` : null
	if (target === 'telegram')
		return cfg.telegramUser ? `tg://resolve?domain=${cfg.telegramUser}` : null
	return null
}

/** The macOS/Windows application name for a target, used when there is no deep link. */
const APP_NAME = { whatsapp: 'WhatsApp', telegram: 'Telegram' }

/** The web fallback, for a platform with no native client (Linux, mainly). */
const WEB_URL = { whatsapp: 'https://web.whatsapp.com', telegram: 'https://web.telegram.org' }

/**
 * Bring the target chat app to the front, deep-linking to a specific chat when the
 * reader has configured one. Returns true iff something was spawned.
 *
 * Always the NATIVE scheme, never `wa.me`: the https form lands on a browser
 * interstitial with a "Continue to Chat" click, and is reported to push people to a
 * QR-scan page even when the desktop app is installed. `whatsapp://` goes straight to
 * the registered handler.
 */
function openChatApp(target, cfg = {}) {
	const url = chatUrl(target, cfg)
	const app = APP_NAME[target]
	if (!app)
		return false

	if (process.platform === 'darwin')
		return url ? launch('open', [url]) : launch('open', ['-a', app])

	if (process.platform === 'win32')
		// explorer.exe, NOT `cmd /c start`: `start` mangles an argument containing `&`,
		// and it treats a leading quoted token as a window title. explorer.exe hands a
		// URL to its registered protocol handler directly. Same reasoning reveal.js gives
		// for preferring it over `start`.
		return launch('explorer.exe', [url || `${target}://`])

	if (headless())
		return false

	// Linux has no native WhatsApp client at all, and Telegram Desktop may or may not be
	// installed. xdg-open handles a registered tg:// either way, and the web client is
	// the honest floor for WhatsApp rather than a scheme nothing answers.
	if (target === 'telegram' && url)
		return launch('xdg-open', [url])
	return launch('xdg-open', [WEB_URL[target]])
}

module.exports = { copyImage, openChatApp, chatUrl, COPY_TIMEOUT_MS }
