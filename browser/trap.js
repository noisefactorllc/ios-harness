/*
 * In-page instrumentation shim. Injected by lib/server.js as the FIRST <script>
 * in <head>, so it runs before any application code. It is plain ES5 browser
 * JS (no modules) so it works in every iOS WebKit version.
 *
 * It exposes window.__iosHarness, which the specs read via driver.evaluate():
 *   .errors[]        uncaught errors / rejections / console.error / failed loads
 *   .warnings[]      console.warn messages
 *   .glContexts[]    {type, lost} for every WebGL(2) context created
 *   .audioContexts[] every AudioContext/webkitAudioContext instance
 *   .gestures        count of real user input events seen
 *
 * It does NOT alter application behavior — it only observes.
 */
(function () {
    if (window.__iosHarness) return
    var H = (window.__iosHarness = {
        ready: true,
        errors: [],
        warnings: [],
        glContexts: [],
        audioContexts: [],
        gestures: 0,
        startedAt: Date.now(),
    })

    function ser(x) {
        if (x == null) return String(x)
        if (typeof x === 'string') return x
        if (typeof x === 'number' || typeof x === 'boolean') return String(x)
        if (x instanceof Error) return (x.name || 'Error') + ': ' + x.message
        if (typeof x === 'object') {
            if (x.message) return String(x.message)
            try {
                return JSON.stringify(x)
            } catch (e) {
                return Object.prototype.toString.call(x)
            }
        }
        return String(x)
    }

    function record(kind, msg, extra) {
        H.errors.push({
            kind: kind,
            message: String(msg),
            stack: extra && extra.stack ? String(extra.stack) : null,
            t: Date.now() - H.startedAt,
        })
    }

    window.addEventListener(
        'error',
        function (e) {
            if (e && e.message) record('error', e.message, e.error)
            else if (e && e.target && (e.target.src || e.target.href))
                record('resource', 'failed to load ' + (e.target.src || e.target.href))
        },
        true
    )

    window.addEventListener('unhandledrejection', function (e) {
        var r = e && e.reason
        record('unhandledrejection', (r && r.message) || r || 'unknown', r)
    })

    var origErr = console.error
    console.error = function () {
        try {
            record('console.error', Array.prototype.map.call(arguments, ser).join(' '))
        } catch (_) {}
        return origErr.apply(console, arguments)
    }

    var origWarn = console.warn
    console.warn = function () {
        try {
            H.warnings.push(Array.prototype.map.call(arguments, ser).join(' '))
        } catch (_) {}
        return origWarn.apply(console, arguments)
    }

    // Tag every GPU rendering context (WebGL, WebGL2, and WebGPU) + detect loss.
    var origGetContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (type) {
        var ctx = origGetContext.apply(this, arguments)
        var isWebGL = type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl'
        if (ctx && (isWebGL || type === 'webgpu')) {
            var rec = { type: type, lost: false }
            H.glContexts.push(rec)
            if (isWebGL) {
                try {
                    this.addEventListener(
                        'webglcontextlost',
                        function () {
                            rec.lost = true
                            record('webglcontextlost', type + ' context lost')
                        },
                        false
                    )
                    // A restored context is no longer lost — track CURRENT state, not
                    // "ever lost". Renderers that recycle their context on interaction
                    // (e.g. loading a new program) lose-then-restore and keep rendering.
                    this.addEventListener(
                        'webglcontextrestored',
                        function () {
                            rec.lost = false
                        },
                        false
                    )
                } catch (_) {}
            }
        }
        return ctx
    }

    // Track AudioContext instances so specs can assert autoplay-after-gesture.
    ;['AudioContext', 'webkitAudioContext'].forEach(function (name) {
        var Orig = window[name]
        if (!Orig) return
        function Wrapped() {
            var inst = new (Function.prototype.bind.apply(
                Orig,
                [null].concat(Array.prototype.slice.call(arguments))
            ))()
            H.audioContexts.push(inst)
            return inst
        }
        Wrapped.prototype = Orig.prototype
        try {
            window[name] = Wrapped
        } catch (_) {}
    })

    // Count genuine user gestures.
    ;['touchstart', 'pointerdown', 'mousedown', 'click', 'keydown'].forEach(function (ev) {
        window.addEventListener(
            ev,
            function () {
                H.gestures++
            },
            true
        )
    })
})()
