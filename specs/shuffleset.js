'use strict'

/**
 * ShuffleSet — streaming player, heavily backend-coupled. Served front-end
 * only: stream/cover endpoints 404 and the app is expected to degrade
 * gracefully (no JS errors). We verify the front-end loads, survives the missing
 * backend, and (if the player shell is present) its transport controls respond.
 * The autoplay-overlay gate is dismissed by the shared load step.
 */

const assert = require('node:assert/strict')
const { sleep, assertAlive, realJsDelta } = require('../lib/spec-helpers')

module.exports = [
    {
        name: 'shuffleset: front-end loads and survives a missing streaming backend',
        async fn(driver, ctx) {
            assert.ok(await assertAlive(driver), 'shuffleset unresponsive on load')
            const counts = await driver.count(['#transport-bar', '#main', '#btn-play-pause', '#transport-seek', 'canvas', 'audio', 'video'])
            ctx.log(`      shell: ${JSON.stringify(counts)}`)
            const hasBody = await driver.evaluate(() => !!(document.body && document.body.innerText && document.body.innerText.trim().length > 0))
            assert.ok(hasBody, 'shuffleset rendered an empty page')
        },
    },

    {
        name: 'shuffleset: transport controls respond (if player shell present)',
        async fn(driver, ctx) {
            if (!(await driver.exists('#btn-play-pause'))) {
                ctx.skip('no player transport on this static entry (likely a landing page without backend PLAYER_DATA)')
            }
            const before = await driver.harness()
            await driver.click('#btn-play-pause')
            await sleep(500)
            // Backend is absent, so audio won't actually play — we only assert the UI
            // handled the tap without throwing (graceful degradation).
            assert.ok(await assertAlive(driver), 'shuffleset crashed after play tap')
            const newErrs = realJsDelta(before, await driver.harness())
            assert.equal(newErrs.length, 0, 'play tap produced JS errors:\n' + newErrs.map((e) => `    ${e.message}`).join('\n'))
        },
    },
]
