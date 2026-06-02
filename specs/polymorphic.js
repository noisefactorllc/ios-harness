'use strict'

/**
 * Polymorphic — shader DSL playground. Flows mined from public/index.html.
 * #code-toggle-btn, #dsl-editor (<code-editor>), #play-pause-btn-menu, #programModal.
 */

const assert = require('node:assert/strict')
const { sleep, realJsDelta } = require('../lib/spec-helpers')

module.exports = [
    {
        name: 'polymorphic: shell present (#canvas + code/play controls)',
        async fn(driver, ctx) {
            const counts = await driver.count(['#canvas', '#code-toggle-btn', '#dsl-editor', '#play-pause-btn-menu', '#menu'])
            ctx.log(`      shell: ${JSON.stringify(counts)}`)
            assert.ok(counts['#canvas'] > 0, 'polymorphic #canvas missing')
        },
    },

    {
        name: 'polymorphic: toggle the code editor',
        async fn(driver, ctx) {
            if (!(await driver.exists('#code-toggle-btn'))) ctx.skip('#code-toggle-btn absent on this layout')
            const before = await driver.harness()
            await driver.click('#code-toggle-btn')
            await sleep(500)
            const hasEditor = await driver.exists('#dsl-editor')
            ctx.log(`      #dsl-editor present after toggle: ${hasEditor}`)
            const newErrs = realJsDelta(before, await driver.harness())
            assert.equal(newErrs.length, 0, 'toggling code editor errored:\n' + newErrs.map((e) => `    ${e.message}`).join('\n'))
        },
    },

    {
        name: 'polymorphic: play/pause toggles without errors or context loss',
        async fn(driver, ctx) {
            const btn = (await driver.exists('#play-pause-btn-menu'))
                ? '#play-pause-btn-menu'
                : (await driver.exists('#play-pause-btn'))
                  ? '#play-pause-btn'
                  : null
            if (!btn) ctx.skip('no play/pause control found')
            const before = await driver.harness()
            await driver.click(btn)
            await sleep(700)
            await driver.click(btn)
            await sleep(700)
            const after = await driver.harness()
            assert.equal(after.glLost - before.glLost, 0, 'WebGL lost during play/pause')
            const newErrs = realJsDelta(before, after)
            assert.equal(newErrs.length, 0, 'play/pause errored:\n' + newErrs.map((e) => `    ${e.message}`).join('\n'))
        },
    },
]
