'use strict'

// Secret hygiene: every stderr log line and serialized error in the CLI and
// kernel must flow through this module. Never place a secret in an Error message.

const registered = new Set()

const PATTERNS = [
	/sk-[A-Za-z0-9_-]{16,}/g,
	/AKIA[0-9A-Z]{16}/g,
	/ghp_[A-Za-z0-9]{36,}/g,
	/bearer\s+\S+/gi,
	/[a-z][a-z0-9+.-]*:\/\/[^:/\s]+:[^@/\s]+@/gi, // URL credentials  user:pass@
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

const MASK = '***REDACTED***'

function registerSecret(value) {
	if (typeof value === 'string' && value.length > 0)
		registered.add(value)
}

function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function redact(str) {
	let out = String(str)
	for (const value of registered)
		out = out.replace(new RegExp(escapeRegExp(value), 'g'), MASK)
	for (const re of PATTERNS)
		out = out.replace(re, MASK)
	return out
}

function serialize(arg) {
	if (arg instanceof Error)
		return arg.stack || arg.message
	if (typeof arg === 'string')
		return arg
	try {
		return JSON.stringify(arg)
	} catch {
		return String(arg)
	}
}

/** Redacted stderr logger. */
function log(...args) {
	process.stderr.write(redact(args.map(serialize).join(' ')) + '\n')
}

/** Redacted serialization of an error for JSON output. */
function errorOut(err, code = 'INTERNAL_ERROR') {
	return {
		code: (err && err.code && /^[A-Z_]+$/.test(String(err.code))) ? err.code : code,
		message: redact(err && err.message ? err.message : String(err)),
	}
}

module.exports = { registerSecret, redact, log, errorOut, MASK }
