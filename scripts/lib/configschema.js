'use strict'

const { PRESET_NAMES, TOKEN_KEYS, MIN_PALETTE, MAX_PALETTE, HEX_COLOR_RE } = require('./theme')

/**
 * The `config` block InstantCanvas declares in its `skill.json`, GENERATED from
 * lib/theme.js.
 *
 * HappySkills enforces the schema we declare, and that is strictly good: a bad write is
 * refused at the boundary, with the exact path and a fix, before it ever reaches a file
 * the agent later reads back as truth.
 *
 * But TWO HAND-MAINTAINED VALIDATORS WILL DIVERGE. `lib/theme.js` is already this
 * project's single source of truth for the tokens, the presets and the colorway — the day
 * we add an eighth token, a schema typed by hand into `skill.json` starts refusing a
 * theme the runtime considers perfectly valid, and nothing says why. So the schema is
 * EMITTED from the same registry the validator reads, exactly as catalog.js is rendered
 * from schema.js. A test (`skillconfig.test.js`) asserts the generated schema and the
 * shipped `skill.json` cannot drift.
 *
 * `prompt: false` on both, because there is no sensible terminal prompt for "a map of
 * named palettes, each with seven colour tokens and a colorway". That UI is our palette
 * editor, and it is the only thing that should ever author this.
 */

// The pattern is lifted from the same regex `theme.check()` enforces, so "strict hex"
// means one thing in this project, not two.
const HEX_PATTERN = HEX_COLOR_RE.source

/** The seven single-color tokens + the colorway — the shape of any theme object. */
function themeSchema(description) {
	const properties = {
		preset: {
			type: 'string',
			enum: [...PRESET_NAMES],
			description: 'Named starting point — supplies an accent, a chart colorway, and (for the dark presets and a few light ones) the paper itself.',
		},
		palette: {
			type: 'array',
			minItems: MIN_PALETTE,
			maxItems: MAX_PALETTE,
			items: { type: 'string', pattern: HEX_PATTERN },
			description: `The chart colorway, ${MIN_PALETTE}–${MAX_PALETTE} hex colors. ONE color is a lead the preset fills out; TWO or more ARE the colorway, exactly as given.`,
		},
	}
	for (const key of TOKEN_KEYS) {
		properties[key] = {
			type: 'string',
			pattern: HEX_PATTERN,
			description: `The "${key}" color token. Strict hex (#rgb or #rrggbb) — these values are assigned into live CSS, which would happily accept anything.`,
		}
	}
	return {
		type: 'object',
		description,
		properties,
		additionalProperties: false,
	}
}

/** The whole `config` block, ready to be compared against — or written into — skill.json. */
function configBlock() {
	return {
		theme: {
			type: 'object',
			default: {},
			prompt: false,
			description: 'Workspace default theme — the colors every document falls back to when it declares none of its own. A canvas (or a markdown file\'s companion canvas) always outranks it.',
			schema: themeSchema('A theme: a named preset, plus any color token override.'),
		},
		palettes: {
			type: 'object',
			default: {},
			prompt: false,
			description: 'Named palette library, authored by the app\'s palette editor. Each entry is a theme object, offered in the browser beside the built-in presets. A LIBRARY, not new preset names: applying one copies its colors into the document.',
			schema: {
				type: 'object',
				description: 'A map of palette name → theme object.',
				additionalProperties: themeSchema('One saved palette: a theme object.'),
			},
		},
	}
}

module.exports = { configBlock, themeSchema, HEX_PATTERN }
