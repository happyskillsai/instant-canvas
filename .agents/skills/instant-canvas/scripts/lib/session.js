'use strict'

const crypto = require('node:crypto')

const DEFAULT_TIMEOUT_S = 600

/**
 * Pending interactive (form/confirm) exchanges. One active session per canvas
 * path — a new `open` supersedes the old one (superseded sessions resolve as
 * cancelled so their poller returns cleanly).
 */
class Sessions {
	constructor() {
		this.byId = new Map()
	}

	create(canvasPath, { timeoutSeconds } = {}) {
		const timeout = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : DEFAULT_TIMEOUT_S
		for (const s of this.byId.values()) {
			if (s.canvasPath === canvasPath && !s.result)
				this.resolve(s.id, { status: 'cancelled', reason: 'superseded', timestamp: new Date().toISOString() })
		}
		const session = {
			id: crypto.randomBytes(16).toString('base64url'),
			canvasPath,
			createdAt: Date.now(),
			timeoutSeconds: timeout,
			expiresAt: Date.now() + timeout * 1000,
			result: null,
		}
		this.byId.set(session.id, session)
		return session
	}

	/** Session by id with lazy expiry: past expiresAt an unresolved session becomes a timeout. */
	get(id) {
		const s = this.byId.get(id)
		if (!s)
			return null
		if (!s.result && Date.now() > s.expiresAt)
			s.result = { status: 'timeout', timeoutSeconds: s.timeoutSeconds, timestamp: new Date().toISOString() }
		return s
	}

	resolve(id, result) {
		const s = this.byId.get(id)
		if (!s || s.result)
			return null
		s.result = result
		return s
	}

	/** Unresolved sessions that just expired (for push notification), plus pending count. */
	sweep() {
		const expired = []
		for (const s of this.byId.values()) {
			if (!s.result && Date.now() > s.expiresAt) {
				s.result = { status: 'timeout', timeoutSeconds: s.timeoutSeconds, timestamp: new Date().toISOString() }
				expired.push(s)
			}
		}
		return expired
	}

	pendingCount() {
		let n = 0
		for (const s of this.byId.values())
			if (!s.result && Date.now() <= s.expiresAt)
				n++
		return n
	}
}

module.exports = { Sessions, DEFAULT_TIMEOUT_S }
