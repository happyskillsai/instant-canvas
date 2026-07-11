'use strict'

const { spawn } = require('node:child_process')

/**
 * Open `url` in the default browser. Returns true if the opener was spawned,
 * false when unavailable (headless Linux) or on spawn failure — the caller
 * prints the URL instead.
 */
function openUrl(url) {
	let cmd, args
	if (process.platform === 'darwin') {
		cmd = 'open'
		args = [url]
	} else if (process.platform === 'win32') {
		cmd = 'cmd'
		args = ['/c', 'start', '', url]
	} else {
		if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)
			return false // headless heuristic
		cmd = 'xdg-open'
		args = [url]
	}
	try {
		const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
		child.on('error', () => { /* swallowed — caller already has the URL */ })
		child.unref()
		return true
	} catch {
		return false
	}
}

module.exports = { openUrl }
