'use strict'

/**
 * Shade — shader editor (FORCES landscape; harness sets orientation). Front-end
 * only: its backend (/api/* — chat, credits, export) is not run here, so those
 * features are NOT exercised. Selectors mined from public/index.html.
 */

const assert = require('node:assert/strict')
const { sleep, realJsDelta } = require('../lib/spec-helpers')

module.exports = [
    {
        name: 'shade: landscape shell present (canvas + editor toggle, no rotate-block)',
        async fn(driver, ctx) {
            const counts = await driver.count(['#canvas', '#canvas-editor', '#toggle-dsl-overlay', '#play-pause-btn'])
            const vis = await driver.viewportVisibility('#canvas')
            ctx.log(`      shell: ${JSON.stringify(counts)}; #canvas visible ${(((vis && vis.visibleFraction) || 0) * 100).toFixed(0)}%`)
            assert.ok(counts['#canvas'] > 0, 'shade #canvas missing')
            // In landscape the rotate-device overlay should not be hiding the app.
            assert.ok(vis.found && vis.visibleFraction >= 0.4, 'shade canvas not visible in landscape (rotate overlay still blocking?)')
        },
    },

    {
        name: 'shade: toggle DSL overlay (code editor)',
        async fn(driver, ctx) {
            if (!(await driver.exists('#toggle-dsl-overlay'))) ctx.skip('#toggle-dsl-overlay absent')
            const before = await driver.harness()
            await driver.click('#toggle-dsl-overlay')
            await sleep(500)
            ctx.log(`      #canvas-editor present: ${await driver.exists('#canvas-editor')}`)
            const newErrs = realJsDelta(before, await driver.harness())
            assert.equal(newErrs.length, 0, 'toggling DSL overlay errored:\n' + newErrs.map((e) => `    ${e.message}`).join('\n'))
        },
    },

    {
        name: 'shade: play/pause runs without errors or context loss',
        async fn(driver, ctx) {
            if (!(await driver.exists('#play-pause-btn'))) ctx.skip('#play-pause-btn absent')
            const before = await driver.harness()
            await driver.click('#play-pause-btn')
            await sleep(700)
            const after = await driver.harness()
            assert.equal(after.glLost - before.glLost, 0, 'WebGL lost during play/pause')
            const newErrs = realJsDelta(before, after)
            assert.equal(newErrs.length, 0, 'play/pause errored:\n' + newErrs.map((e) => `    ${e.message}`).join('\n'))
        },
    },
]
