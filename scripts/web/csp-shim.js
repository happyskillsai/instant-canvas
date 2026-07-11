// Must load BEFORE plotly.min.js. Reconciles Plotly with `style-src 'self'`.
//
// Plotly styles itself two ways that a strict CSP rejects. Both are silent
// failures — the chart still draws, but colorbars and chrome degrade and the
// console fills with violations. Both are fixed here, and both were verified
// in a browser under the kernel's real CSP.

;(function () {
	// 1. Plotly injects a <style> element at load and calls insertRule() on it.
	//    Its own dom.js bails out early if an element with the target id already
	//    exists and matches `.no-inline-styles`. We plant a <div> — not a <style>
	//    — so no stylesheet is ever created for the browser to block. The rules
	//    themselves arrive via the vendored plotly.css <link>, which is 'self'.
	function stub(id, cls) {
		if (document.getElementById(id))
			return
		const el = document.createElement('div')
		el.id = id
		if (cls) el.className = cls
		el.hidden = true
		;(document.head || document.documentElement).appendChild(el)
	}
	stub('plotly.js-style-global', 'no-inline-styles')
	// esbuild inlines maplibre's stylesheet even though no map trace is bundled;
	// it is id-guarded by a content hash, so the same trick suppresses it.
	stub('841bfaab4686cc02a8fcf0aec91384a88c50541e34b41e6ecd1f6128b0c4c4c8')

	// 2. The colorbar writes setAttribute('style', …) on its fill rect, which
	//    `style-src 'self'` blocks (style-src-attr) exactly as it blocks the
	//    fieldset grid styles this app already works around. CSSOM assignment is
	//    exempt, so route the write there instead of letting it be dropped.
	const setAttribute = Element.prototype.setAttribute
	Element.prototype.setAttribute = function (name, value) {
		if (String(name).toLowerCase() === 'style') {
			const css = String(value)
			if (css === '')
				this.removeAttribute('style')
			else
				this.style.cssText = css
			return
		}
		return setAttribute.apply(this, arguments)
	}
})()
