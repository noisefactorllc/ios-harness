'use strict'

/**
 * Foundry — shader editor served by its REAL node server (real CSP). FORCES
 * landscape (harness sets orientation). Loads shader bundles from external hosts,
 * so the device needs network. Selectors mined from public/index.html.
 */

const assert = require('node:assert/strict')
const { sleep, realJsDelta } = require('../lib/spec-helpers')

module.exports = [
    {
        name: 'foundry: loads past the loading screen with a live renderer (real CSP)',
        timeout: 45000,
        async fn(driver, ctx) {
            // App reveals itself (#app.loaded / loading-screen fades) once the renderer is up.
            await driver
                .ready(
                    'return document.readyState === "complete" && !!document.querySelector("#canvas") && !document.querySelector("#loading-screen:not(.hidden)")',
                    { timeout: 30000 }
                )
                .catch(() => {}) // tolerate apps that don't use #loading-screen markup
            const counts = await driver.count(['#canvas', '#toggle-dsl-overlay', '#menuLeft'])
            const vis = await driver.viewportVisibility('#canvas')
            ctx.log(`      shell: ${JSON.stringify(counts)}; #canvas visible ${(((vis && vis.visibleFraction) || 0) * 100).toFixed(0)}%`)
            assert.ok(counts['#canvas'] > 0, 'foundry #canvas missing — CSP/landscape/load problem?')
            assert.ok(vis.found && vis.visibleFraction >= 0.4, 'foundry canvas not visible in landscape')
        },
    },

    {
        name: 'foundry: CSP did not break the WebGL renderer',
        async fn(driver, ctx) {
            const h = await driver.harness()
            // foundry CSP uses 'unsafe-eval' for shader compilation; verify a live GL context exists.
            assert.ok(h.present, 'instrumentation shim missing (trap injection failed under CSP?)')
            assert.ok(h.glContextCount > 0, 'no WebGL context — CSP or external shader-bundle load likely failed on iOS')
            assert.equal(h.glLost, 0, 'WebGL context lost')
            ctx.log(`      ${h.glContextCount} GL context(s); ${h.warnings.length} warning(s)`)
        },
    },

    {
        name: 'foundry: toggle DSL editor without errors',
        async fn(driver, ctx) {
            if (!(await driver.exists('#toggle-dsl-overlay'))) ctx.skip('#toggle-dsl-overlay absent')
            const before = await driver.harness()
            await driver.click('#toggle-dsl-overlay')
            await sleep(500)
            const newErrs = realJsDelta(before, await driver.harness())
            assert.equal(newErrs.length, 0, 'toggling DSL editor errored:\n' + newErrs.map((e) => `    ${e.message}`).join('\n'))
        },
    },
]
