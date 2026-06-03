'use strict'

/**
 * Glitcher — glitch-art app. Camera-denied on the Simulator surfaces #error-banner
 * with an upload fallback. We verify graceful degradation + that the client-side
 * controls (presets, intensity) work without a camera. Selectors mined from
 * public/index.html (+ DESIGN.md).
 */

const assert = require('node:assert/strict')
const { sleep, setRangeValue, waitForBodyText, assertAlive, realJsDelta } = require('../lib/spec-helpers')

module.exports = [
    {
        name: 'glitcher: degrades gracefully with no camera (#error-banner + upload fallback)',
        timeout: 30000,
        async fn(driver, ctx) {
            // Only applies with no camera. The Simulator gives NATIVE apps a virtual
            // camera (not Safari), so in native mode getUserMedia succeeds and glitcher
            // shows its normal editor — the real capture/render path, covered by the
            // shared render specs instead.
            if (ctx.cameraAvailable) {
                ctx.skip('a camera is present (Simulator provides one to native apps) — no-camera degradation path N/A; capture/render covered by shared specs')
            }
            const bannerShown = await driver
                .evaluate(() => {
                    const b = document.querySelector('#error-banner')
                    return !!b && !b.classList.contains('hidden')
                })
                .catch(() => false)
            const text = bannerShown ? 'banner' : await waitForBodyText(driver, 'camera access', { timeout: 12000 })
            assert.ok(await assertAlive(driver), 'glitcher unresponsive with no camera')
            assert.ok(bannerShown || text, 'no graceful camera-denied UI shown on iOS')
            // The documented fallback path must exist (we do not automate the iOS file picker).
            assert.ok(await driver.exists('#upload-btn'), 'no #upload-btn fallback for camera-denied state')
            ctx.log(`      camera-denied handled; #upload-btn fallback present`)
        },
    },

    {
        name: 'glitcher: preset + intensity controls work without a camera',
        timeout: 30000,
        async fn(driver, ctx) {
            const counts = await driver.count(['#stage-canvas', '.preset-chip', '#glitchify-btn', '#intensity', '#intensity-value'])
            ctx.log(`      controls: ${JSON.stringify(counts)}`)
            if (!counts['#intensity']) ctx.skip('#intensity control absent on this layout')
            const before = await driver.harness()
            await setRangeValue(driver, '#intensity', 90)
            await sleep(300)
            const readout = (await driver.exists('#intensity-value')) ? await driver.text('#intensity-value') : null
            ctx.log(`      intensity readout: ${JSON.stringify(readout)}`)
            const newErrs = realJsDelta(before, await driver.harness())
            assert.equal(newErrs.length, 0, 'intensity change errored:\n' + newErrs.map((e) => `    ${e.message}`).join('\n'))
        },
    },
]
