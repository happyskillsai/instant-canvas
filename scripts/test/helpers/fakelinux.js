'use strict'

// -r preload: masquerade as display-less Linux so openUrl()'s headless
// heuristic (and the CLI's BROWSER_OPEN_FAILED warn) can be exercised from
// any platform. The state dir is unaffected: INSTANTCANVAS_STATE_DIR is set
// by every test file and wins over the platform-specific default.
Object.defineProperty(process, 'platform', { value: 'linux' })
delete process.env.DISPLAY
delete process.env.WAYLAND_DISPLAY
