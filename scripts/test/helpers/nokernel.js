'use strict'

// -r preload: sabotage the CLI's kernel spawn (the child exits immediately
// and never registers) so the KERNEL_UNREACHABLE spawn deadline can be
// exercised — shorten it with INSTANTCANVAS_SPAWN_WAIT_MS.
const cp = require('node:child_process')

const realSpawn = cp.spawn
cp.spawn = function spawn(cmd, args, opts) {
	if (Array.isArray(args) && typeof args[0] === 'string' && args[0].endsWith('kernel.js'))
		args = ['-e', 'process.exit(1)']
	return realSpawn.call(this, cmd, args, opts)
}
