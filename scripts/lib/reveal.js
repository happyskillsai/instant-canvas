'use strict'

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

// Reveal a folder in the OS file manager, or open a terminal already cd'd into it.
//
// Sibling of lib/browser.js `openUrl` and built on the same shape: pick a cmd + argv
// per platform, spawn detached with stdio ignored, swallow the error event, unref,
// return a boolean. Two rules are load-bearing here in a way they are not there:
//
//   - NEVER build a shell string. A folder named `; rm -rf ~` is a legal filename on
//     macOS and Linux, so the directory is always ONE argv entry handed to spawn()
//     directly. There is no exec, no execSync and no shell:true anywhere in this file.
//   - The path is NOT validated here. Confinement is the caller's job (the kernel's
//     /api/reveal route confines with insideRoot + lstat before we are reached), and
//     two copies of a security check are two copies that drift apart.

/** The Linux terminals we try, in order, when TERMINAL is not set. First hit wins. */
const LINUX_TERMINALS = [
	'x-terminal-emulator', // Debian/Ubuntu alternatives symlink — whatever the user chose
	'gnome-terminal',
	'konsole',
	'xfce4-terminal',
	'alacritty',
	'kitty',
]

/** True when a graphical session looks absent — the same heuristic `openUrl` uses. */
const headless = () => !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY

/**
 * Resolve `cmd` to an executable file by scanning PATH, mirroring `findChrome`'s
 * "probe known locations, return null if none" structure. Returns the command name
 * (not the resolved path) so spawn still gets a plain argv[0], or null when absent.
 */
function onPath(cmd) {
	if (!cmd)
		return null
	const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
	const exts = process.platform === 'win32'
		? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
		: ['']
	for (const dir of dirs) {
		for (const ext of exts) {
			try {
				if (fs.statSync(path.join(dir, cmd + ext)).isFile())
					return cmd
			} catch { /* not here — keep probing */ }
		}
	}
	return null
}

/** Spawn a detached opener. Returns true iff the spawn itself did not throw. */
function launch(cmd, args, cwd) {
	try {
		// windowsHide keeps a console window from flashing on Windows; ignored elsewhere.
		const opts = { stdio: 'ignore', detached: true, windowsHide: true }
		if (cwd) opts.cwd = cwd
		const child = spawn(cmd, args, opts)
		child.on('error', () => { /* swallowed — the caller already reported what it could */ })
		child.unref()
		return true
	} catch {
		return false
	}
}

/**
 * Reveal `dir` (an absolute directory path) in the OS file manager.
 * Returns true if an opener was spawned, false when none is available.
 */
function revealDir(dir) {
	if (process.platform === 'darwin')
		return launch('open', [dir])
	if (process.platform === 'win32')
		// explorer.exe, NOT `cmd /c start`: `start` mangles a path containing `&`, and
		// explorer.exe is also the command a future file-reveal (/select,) would use.
		return launch('explorer.exe', [dir])
	if (headless())
		return false
	return launch('xdg-open', [dir])
}

/**
 * Open the platform's terminal already cd'd into `dir` (an absolute directory path).
 * Returns true if a terminal was spawned, false when none could be found — the caller
 * turns that into NO_TERMINAL rather than failing silently.
 */
function openTerminal(dir) {
	if (process.platform === 'darwin')
		return launch('open', ['-a', 'Terminal', dir])

	if (process.platform === 'win32') {
		// Windows Terminal when it is on PATH, else the shell that ships with every
		// install. wt.exe is NOT detected through a registry lookup: it is a Store app
		// whose install location moves, and inventing a registry probe we cannot test
		// here would be a guess dressed as a check (see the spec's uncertainty #2).
		if (onPath('wt.exe'))
			return launch('wt.exe', ['-d', dir])
		return launch('cmd.exe', ['/c', 'start', '', 'cmd.exe', '/K', 'cd', '/d', dir])
	}

	if (headless())
		return false

	// The ladder. $TERMINAL first — the user's own answer outranks ours — then the
	// common emulators. Each is probed on PATH before it is spawned, so an exhausted
	// ladder returns false instead of spawning something that is not there.
	for (const cand of [process.env.TERMINAL, ...LINUX_TERMINALS]) {
		if (!onPath(cand))
			continue
		// --working-directory is gnome-terminal/xfce4-terminal's spelling; the rest take
		// the POSIX --working-directory or -d. Passing the dir as its own argv entry is
		// the invariant that matters — a terminal that ignores the flag still opens.
		if (cand === 'gnome-terminal' || cand === 'xfce4-terminal')
			return launch(cand, ['--working-directory=' + dir])
		if (cand === 'konsole')
			return launch(cand, ['--workdir', dir])
		if (cand === 'alacritty' || cand === 'kitty')
			return launch(cand, ['--working-directory', dir])
		// x-terminal-emulator (and $TERMINAL, which may be anything) has no portable
		// working-directory flag, so the cwd is set on the SPAWN instead of the argv —
		// a terminal inherits its cwd, so it still opens in the right folder.
		return launch(cand, [], dir)
	}
	return false
}

module.exports = { revealDir, openTerminal }
