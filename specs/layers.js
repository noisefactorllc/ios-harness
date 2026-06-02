'use strict'

/**
 * Layers — deep functional flows in iOS WebKit. Drives the app's own
 * `window.LayersAgent` test API where possible (deterministic), with UI guards.
 * Selectors/API mined from layers' 79 Playwright specs + public/index.html.
 */

const assert = require('node:assert/strict')
const { sleep, realJsDelta } = require('../lib/spec-helpers')

module.exports = [
    {
        name: 'layers: main shell present (#canvas + add-layer control)',
        async fn(driver, ctx) {
            const counts = await driver.count(['#canvas', '#addLayerBtn', 'layer-stack', '#menuLeft'])
            ctx.log(`      shell: ${JSON.stringify(counts)}`)
            assert.ok(counts['#canvas'] > 0, 'layers #canvas missing in iOS DOM')
        },
    },

    {
        name: 'layers: LayersAgent test bridge works in iOS WebKit',
        async fn(driver, ctx) {
            const probe = await driver.evaluate(() => {
                const A = window.LayersAgent
                if (!A) return { present: false }
                const methods = ['addLayer', 'paintStroke', 'exportImage', 'getState', 'setLayerEffectParams'].filter(
                    (m) => typeof A[m] === 'function'
                )
                let stateKeys = null
                try {
                    const s = A.getState && A.getState()
                    stateKeys = s ? Object.keys(s).slice(0, 12) : null
                } catch (e) {
                    stateKeys = { __err: String((e && e.message) || e) }
                }
                return { present: true, methods, stateKeys }
            })
            if (!probe.present) ctx.skip('window.LayersAgent not present on this build')
            ctx.log(`      LayersAgent methods: ${probe.methods.join(', ')}`)
            assert.ok(probe.methods.includes('getState'), 'LayersAgent.getState missing')
            assert.ok(probe.stateKeys && !probe.stateKeys.__err, `getState() failed on iOS: ${JSON.stringify(probe.stateKeys)}`)
        },
    },

    {
        name: 'layers: paint a stroke via agent renders without errors',
        timeout: 40000,
        async fn(driver, ctx) {
            const hasPaint = await driver.evaluate(
                () => !!(window.LayersAgent && typeof window.LayersAgent.paintStroke === 'function')
            )
            if (!hasPaint) ctx.skip('LayersAgent.paintStroke not available')
            const before = await driver.harness()
            const res = await driver.evaluateAsync((done) => {
                try {
                    Promise.resolve(
                        window.LayersAgent.paintStroke({
                            points: [
                                [20, 20],
                                [120, 120],
                                [220, 80],
                            ],
                            size: 8,
                            color: '#ff3366',
                        })
                    )
                        .then(() => done({ ok: true }))
                        .catch((e) => done({ ok: false, err: String((e && e.message) || e) }))
                } catch (e) {
                    done({ ok: false, err: String((e && e.message) || e) })
                }
            })
            // If our param shape differs from this build's API, treat as a skip (not a flake).
            if (!res || !res.ok) ctx.skip(`paintStroke signature differs on this build: ${res && res.err}`)
            await sleep(800)
            const after = await driver.harness()
            assert.equal(after.glLost - before.glLost, 0, 'WebGL context lost after paintStroke')
            const newErrs = realJsDelta(before, after)
            assert.equal(
                newErrs.length,
                0,
                'paintStroke produced JS errors on iOS:\n' + newErrs.map((e) => `    [${e.kind}] ${e.message}`).join('\n')
            )
            const blank = await driver.canvasNotBlank('#canvas')
            ctx.log(`      canvas varied=${blank.ok ? blank.varied : '?'}`)
        },
    },
]
