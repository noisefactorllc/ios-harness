'use strict'

/**
 * In-page probes. Each function is serialized (fn.toString()) and executed
 * INSIDE the iOS WebKit page via driver.evaluate / evaluateAsync. They must be
 * self-contained (no closures over Node scope) and return JSON-serializable
 * values. Async probes take a trailing `done` callback (executeAsync contract).
 */

/** Snapshot of the instrumentation shim's captured state. */
function harnessState() {
    var H = window.__iosHarness
    if (!H) return { present: false }
    return {
        present: true,
        errors: H.errors.slice(0, 50),
        errorCount: H.errors.length,
        warnings: H.warnings.slice(0, 30),
        glContextCount: H.glContexts.length,
        glLost: H.glContexts.filter(function (g) {
            return g.lost
        }).length,
        audioStates: H.audioContexts.map(function (a) {
            try {
                return a.state
            } catch (e) {
                return 'unknown'
            }
        }),
        gestures: H.gestures,
    }
}

/** Geometry + backing-store size of a canvas (or other element). */
function elementInfo(selector) {
    var c = document.querySelector(selector)
    if (!c) return { found: false }
    var r = c.getBoundingClientRect()
    return {
        found: true,
        tag: c.tagName,
        width: c.width || null,
        height: c.height || null,
        clientWidth: c.clientWidth,
        clientHeight: c.clientHeight,
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        devicePixelRatio: window.devicePixelRatio || 1,
    }
}

/**
 * Whether the canvas shows visual variation (not a single flat color).
 * Waits one animation frame so a freshly composited frame exists. Best-effort:
 * a WebGL canvas without preserveDrawingBuffer can read back blank even when
 * visibly rendering, so callers should treat `varied:false` as a soft signal and
 * corroborate with a live, unlost GL context.
 */
function canvasNotBlank(selector, done) {
    var finished = false
    function finish(v) {
        if (finished) return
        finished = true
        done(v)
    }
    function sample(c) {
        try {
            var s = document.createElement('canvas')
            var w = (s.width = Math.min(64, c.width))
            var h = (s.height = Math.min(64, c.height))
            var ctx = s.getContext('2d')
            ctx.drawImage(c, 0, 0, w, h)
            var data = ctx.getImageData(0, 0, w, h).data
            var first = [data[0], data[1], data[2]]
            var varied = false
            var lum = 0
            var n = 0
            for (var i = 0; i < data.length; i += 4) {
                if (data[i] !== first[0] || data[i + 1] !== first[1] || data[i + 2] !== first[2]) varied = true
                lum += data[i] + data[i + 1] + data[i + 2]
                n++
            }
            finish({ ok: true, varied: varied, meanLum: lum / (n * 3), sampleW: w, sampleH: h })
        } catch (e) {
            finish({ ok: false, reason: String((e && e.message) || e) })
        }
    }
    try {
        var c = document.querySelector(selector || 'canvas')
        if (!c || !c.width || !c.height) return finish({ ok: false, reason: 'no-canvas' })
        // Prefer a freshly composited frame, but never hang if rAF is throttled
        // (iOS Safari throttles rAF on backgrounded/inactive webviews).
        requestAnimationFrame(function () {
            sample(c)
        })
        setTimeout(function () {
            sample(c)
        }, 1200)
    } catch (e) {
        finish({ ok: false, reason: String((e && e.message) || e) })
    }
}

/** Fraction of the primary element that is actually within the viewport. */
function viewportVisibility(selector) {
    var el = document.querySelector(selector)
    if (!el) return { found: false }
    var r = el.getBoundingClientRect()
    var vw = window.innerWidth
    var vh = window.innerHeight
    var visibleW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0))
    var visibleH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))
    var area = r.width * r.height
    return {
        found: true,
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        viewport: { w: vw, h: vh, dpr: window.devicePixelRatio || 1 },
        visibleFraction: area > 0 ? (visibleW * visibleH) / area : 0,
    }
}

/** Resume any suspended AudioContexts (call from within a user-gesture handler). */
function resumeAudio(done) {
    var H = window.__iosHarness
    var ctxs = (H && H.audioContexts) || []
    Promise.all(
        ctxs.map(function (a) {
            try {
                return a.state === 'suspended' && a.resume ? a.resume() : Promise.resolve()
            } catch (e) {
                return Promise.resolve()
            }
        })
    ).then(function () {
        done(
            ctxs.map(function (a) {
                try {
                    return a.state
                } catch (e) {
                    return 'unknown'
                }
            })
        )
    })
}

/** Dispatch a realistic DOM pointer drag across an element (canvas interaction). */
function domDrag(sel, x0f, y0f, x1f, y1f) {
    var c = document.querySelector(sel)
    if (!c) return { ok: false, reason: 'no-el' }
    var r = c.getBoundingClientRect()
    function pt(fx, fy) {
        return { x: r.left + r.width * fx, y: r.top + r.height * fy }
    }
    var a = pt(x0f, y0f)
    var b = pt(x1f, y1f)
    function fire(type, p, buttons) {
        var ev
        try {
            ev = new PointerEvent(type, {
                bubbles: true,
                cancelable: true,
                clientX: p.x,
                clientY: p.y,
                pointerId: 1,
                pointerType: 'touch',
                isPrimary: true,
                buttons: buttons,
            })
        } catch (e) {
            ev = new MouseEvent(type.replace('pointer', 'mouse'), {
                bubbles: true,
                cancelable: true,
                clientX: p.x,
                clientY: p.y,
            })
        }
        c.dispatchEvent(ev)
    }
    fire('pointerdown', a, 1)
    var steps = 8
    for (var i = 1; i <= steps; i++) {
        fire('pointermove', { x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps }, 1)
    }
    fire('pointerup', b, 0)
    return { ok: true, from: a, to: b }
}

/** Count elements matching any of several selectors (UI presence checks). */
function countSelectors(selectors) {
    var out = {}
    for (var i = 0; i < selectors.length; i++) {
        out[selectors[i]] = document.querySelectorAll(selectors[i]).length
    }
    return out
}

module.exports = {
    harnessState,
    elementInfo,
    canvasNotBlank,
    viewportVisibility,
    resumeAudio,
    domDrag,
    countSelectors,
}
