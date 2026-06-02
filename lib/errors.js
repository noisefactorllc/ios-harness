'use strict'

/**
 * Classify in-page errors captured by the instrumentation shim.
 *
 * We hard-fail only on genuine JS breakage (TypeErrors, unhandled rejections,
 * console.error) — the high-signal iOS regressions. Network/asset failures are
 * separated out: for backend-gated products they are expected; elsewhere they
 * are surfaced as info rather than flaking the run on a transient external CDN.
 */

const NETWORKISH =
    /Failed to load|load (the )?resource|fetch|NetworkError|ERR_|\/api\/|https?:\/\/|XMLHttpRequest|status of 4\d\d|status of 5\d\d/i

function classifyErrors(errors) {
    const networkish = []
    const realJs = []
    for (const e of errors || []) {
        const m = `${e.kind} ${e.message}`
        if (e.kind === 'resource' || NETWORKISH.test(m)) {
            networkish.push(e)
        } else if (e.kind === 'error' || e.kind === 'unhandledrejection' || e.kind === 'console.error') {
            realJs.push(e)
        } else {
            networkish.push(e)
        }
    }
    return { networkish, realJs }
}

/** Real JS errors that appeared between two harness snapshots. */
function realJsDelta(before, after) {
    const newOnes = (after.errors || []).slice(before.errorCount || 0)
    return classifyErrors(newOnes).realJs
}

module.exports = { classifyErrors, realJsDelta, NETWORKISH }
