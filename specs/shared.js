'use strict'

/**
 * Shared iOS-risk suite — runs against EVERY product. These detect the
 * iOS-WebKit-specific failures the desktop Playwright harness cannot see.
 *
 * Each entry: { name, fn(driver, ctx), capability?, timeout? }
 *   - throw to fail; ctx.skip(reason) to skip; return to pass.
 */

const assert = require('node:assert/strict')
const { classifyErrors } = require('../lib/errors')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Drop product-declared benign messages (e.g. expected camera-denied logs). */
function dropBenign(realJs, product) {
    const benign = (product.benignErrors || []).map((s) => new RegExp(s, 'i'))
    if (!benign.length) return realJs
    return realJs.filter((e) => !benign.some((re) => re.test(e.message)))
}

module.exports = [
    {
        name: 'loads in iOS WebKit and becomes interactive',
        timeout: 60000,
        async fn(driver, ctx) {
            await driver.goto(ctx.url)
            // Foreground OUR tab — iOS Safari suspends WebGL/rAF/timers in background
            // tabs, and a foreign restored tab can sit in front.
            const tabs = await driver.ensureForeground(ctx.url)
            if (tabs > 1) ctx.log(`      ${tabs} tabs open; foregrounded our app`)
            // Reload our (now-foreground) tab so the renderer runs and the
            // server-injected shim is present from the very first script.
            await driver.goto(ctx.url)
            // Belt-and-suspenders: ensure the instrumentation shim is present
            // (covers node-served products where the server can't inject it).
            await driver.installTrap()
            // Dismiss any boot / project-picker / autoplay gate before readiness.
            // Declared gates may render just after load, so poll briefly for each.
            for (const gate of ctx.product.gates || []) {
                let tapped = false
                for (let i = 0; i < 6 && !tapped; i++) {
                    tapped = await driver.tapIfPresent(gate)
                    if (!tapped) await sleep(500)
                }
                if (tapped) {
                    ctx.log(`      dismissed gate: ${gate}`)
                    await sleep(700)
                }
            }
            await driver.ready(ctx.product.ready, { timeout: 40000 })
            const title = await driver.title()
            ctx.log(`      title: ${JSON.stringify(title)}`)
        },
    },

    {
        name: 'no uncaught JS errors during load',
        async fn(driver, ctx) {
            const h = await driver.harness()
            if (!h.present) ctx.skip('instrumentation shim not present')
            const { networkish, realJs } = classifyErrors(h.errors)
            if (networkish.length) {
                ctx.log(`      (${networkish.length} network/asset error(s)${ctx.product.backendGated ? ', expected — backend not exercised' : ''})`)
            }
            const real = dropBenign(realJs, ctx.product)
            assert.equal(
                real.length,
                0,
                `uncaught JS error(s) in iOS WebKit:\n` + real.map((e) => `    [${e.kind}] ${e.message}`).join('\n')
            )
        },
    },

    {
        name: 'WebGL context is created and not lost',
        capability: 'webgl',
        async fn(driver, ctx) {
            if (ctx.product.requiresCamera) {
                ctx.skip('renderer needs a camera feed the Simulator lacks — see the camera-denied spec')
            }
            // Renderers often create their GL context asynchronously (shader load,
            // first rAF). Poll up to 15s rather than checking once and racing init.
            let h = await driver.harness()
            const deadline = Date.now() + 15000
            while (h.glContextCount === 0 && Date.now() < deadline) {
                await sleep(500)
                h = await driver.harness()
            }
            assert.ok(h.glContextCount > 0, 'no WebGL/WebGL2 context created within 15s — renderer failed to initialize on iOS')
            assert.equal(h.glLost, 0, `${h.glLost} WebGL context(s) were lost on iOS`)
            ctx.log(`      ${h.glContextCount} GL context(s), 0 lost`)
        },
    },

    {
        name: 'primary UI is within the iPhone viewport (no safe-area clipping)',
        async fn(driver, ctx) {
            if (ctx.product.requiresCamera) {
                ctx.skip('primary render surface is hidden without a camera — see the camera-denied spec')
            }
            const v = await driver.viewportVisibility(ctx.product.primarySelector)
            assert.ok(v.found, `primary surface "${ctx.product.primarySelector}" not found in DOM`)
            ctx.log(`      viewport ${v.viewport.w}x${v.viewport.h}@${v.viewport.dpr}x, primary visible ${(v.visibleFraction * 100).toFixed(0)}%`)
            assert.ok(
                v.visibleFraction >= 0.5,
                `primary surface only ${(v.visibleFraction * 100).toFixed(0)}% within viewport — likely clipped by safe-area / chrome on iPhone`
            )
        },
    },

    {
        name: 'renders content (non-blank canvas / live GL context)',
        capability: 'webgl',
        async fn(driver, ctx) {
            if (ctx.product.requiresCamera) {
                ctx.skip('rendering needs a camera feed the Simulator lacks — see the camera-denied spec')
            }
            const primary = ctx.product.primarySelector.split(',')[0].trim()
            // These are continuous renderers — poll the canvas for visual variation.
            let blank = { ok: false, reason: 'not sampled' }
            const deadline = Date.now() + 8000
            do {
                blank = await driver.canvasNotBlank(primary)
                if (blank.ok && blank.varied) break
                await sleep(500)
            } while (Date.now() < deadline)
            const h = await driver.harness()
            assert.equal(h.glLost, 0, 'WebGL context was lost')
            // drawImage readback can be blank for non-preserveDrawingBuffer WebGL even
            // while visibly rendering — corroborate with a live, unlost GL context.
            const liveGl = h.glContextCount > 0 && h.glLost === 0
            ctx.log(`      canvas varied=${blank.ok ? blank.varied : '?'} (${blank.reason || 'ok'}), liveGL=${liveGl}`)
            assert.ok(
                (blank.ok && blank.varied) || liveGl,
                `canvas appears blank and no live GL context — nothing is rendering on iOS (${blank.reason || ''})`
            )
        },
    },

    {
        name: 'Web Audio is not permanently blocked by autoplay policy',
        capability: 'audio',
        async fn(driver, ctx) {
            // iOS only allows AudioContext.resume() from a real user gesture — a
            // native tap satisfies that (DOM-synthesized events do not).
            await driver.tapNativeAt(0.5, 0.55).catch((e) => ctx.log(`      (native tap unavailable: ${e.message})`))
            await sleep(400)
            const states = await driver.resumeAudio()
            if (!states || states.length === 0) {
                ctx.skip('app created no AudioContext yet (audio likely starts on deeper interaction)')
            }
            ctx.log(`      audio states after gesture+resume: ${states.join(', ')}`)
            assert.ok(
                states.some((s) => s === 'running'),
                `all AudioContexts stuck "${states.join(',')}" after a real gesture — autoplay regression on iOS`
            )
        },
    },

    {
        name: 'survives basic interaction without crashing or reloading',
        async fn(driver, ctx) {
            const primary = ctx.product.primarySelector.split(',')[0].trim()
            if (ctx.product.capabilities.drag) {
                await driver.domDrag(primary, 0.3, 0.4, 0.7, 0.6).catch(() => {})
            }
            await driver.tapNativeAt(0.5, 0.5).catch(() => {})
            await sleep(600)
            // Page must still be alive and responsive.
            const alive = await driver.evaluate(() => 2 + 2).catch(() => null)
            assert.equal(alive, 4, 'page is unresponsive (possible crash/reload) after interaction')
            const h = await driver.harness()
            assert.equal(h.glLost, 0, 'WebGL context lost during interaction')
            const real = dropBenign(classifyErrors(h.errors).realJs, ctx.product)
            assert.equal(
                real.length,
                0,
                `new uncaught JS error(s) after interaction:\n` + real.map((e) => `    [${e.kind}] ${e.message}`).join('\n')
            )
        },
    },
]
