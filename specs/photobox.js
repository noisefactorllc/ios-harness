'use strict'

/**
 * Photobox — camera app with NO file fallback. The iOS Simulator has no camera,
 * so getUserMedia fails; the CORRECT behavior is a graceful "Camera access
 * required" message in #stage (not a crash/white screen). That graceful
 * degradation IS the iOS test here. Selectors mined from public/.
 */

const assert = require('node:assert/strict')
const { waitForBodyText, assertAlive } = require('../lib/spec-helpers')

module.exports = [
    {
        name: 'photobox: degrades gracefully with no camera (shows access-required, no crash)',
        timeout: 30000,
        async fn(driver, ctx) {
            // The no-camera path only applies when there's genuinely no camera. The
            // iOS Simulator gives NATIVE apps a virtual camera (but not Safari), so in
            // native mode getUserMedia succeeds and the app shows its normal capture UI
            // — the real camera/render path, covered by the shared render specs instead.
            if (ctx.cameraAvailable) {
                ctx.skip('a camera is present (Simulator provides one to native apps) — no-camera degradation path N/A; capture/render covered by shared specs')
            }
            // getUserMedia rejection is async; poll for the app's own error copy.
            const text = await waitForBodyText(driver, 'camera access', { timeout: 15000 })
            assert.ok(await assertAlive(driver), 'photobox is unresponsive (crashed) when no camera is present')
            assert.ok(
                text,
                'expected a graceful "Camera access required" message when no camera is present — none shown (white screen / silent failure on iOS?)'
            )
            ctx.log(`      graceful camera-required message shown`)
        },
    },

    {
        name: 'photobox: UI chrome stays interactive without a camera',
        async fn(driver, ctx) {
            const counts = await driver.count(['#shutter-btn', '.mode-btn', '.tab-btn', '#about-btn'])
            ctx.log(`      controls: ${JSON.stringify(counts)}`)
            // Tapping a mode/tab control must not crash the page even with no camera.
            for (const sel of ['.tab-btn', '#about-btn']) {
                if (await driver.exists(sel)) {
                    await driver.tapIfPresent(sel)
                    break
                }
            }
            assert.ok(await assertAlive(driver), 'photobox became unresponsive after tapping a control')
        },
    },
]
