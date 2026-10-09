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

/** Real JS errors that appeared between two snapshots.
 *
 * harnessState caps the returned `errors` window (most recent 50) while
 * `errorCount` keeps the true total, so slice by the count delta and take the
 * newest entries. A head-based slice of the capped window returns nothing once
 * a page has captured more than 50 errors, which would silently disable every
 * "no new JS errors" assertion.
 */
function realJsDelta(before, after) {
    const newCount = (after.errorCount || 0) - (before.errorCount || 0)
    if (newCount <= 0) return []
    const errs = after.errors || []
    const newOnes = errs.slice(Math.max(0, errs.length - newCount))
    return classifyErrors(newOnes).realJs
}

module.exports = { classifyErrors, realJsDelta, NETWORKISH }
