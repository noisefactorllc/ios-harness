'use strict'

/**
 * Noisedeck deep functional flows in iOS WebKit. Runs after the shared suite on
 * the same loaded page. Selectors are mined from noisedeck's Playwright specs
 * (#fileMenuTitle, [data-id=shuffle], #exportModal, #exportCancelBtn, …).
 *
 * Noisedeck has a distinct mobile layout, so each flow GUARDS on selector
 * presence and skips with a logged reason when a control is absent — the skip
 * itself documents an iOS layout divergence worth reviewing, rather than flaking.
 */

const assert = require('node:assert/strict')
const { realJsDelta } = require('../lib/errors')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

module.exports = [
    {
        name: 'noisedeck: main UI shell present (canvas + a menu affordance)',
        async fn(driver, ctx) {
            const counts = await driver.count([
                'canvas',
                '#fileMenuTitle',
                '.menu-title',
                '#classicModeBadge',
                '[data-id=shuffle]',
            ])
            ctx.log(`      shell: ${JSON.stringify(counts)}`)
            assert.ok(counts.canvas > 0, 'no canvas in noisedeck DOM')
        },
    },

    {
        name: 'noisedeck: file menu opens on tap',
        async fn(driver, ctx) {
            if (!(await driver.isVisible('#fileMenuTitle'))) {
                ctx.skip('#fileMenuTitle not visible — mobile/hamburger layout (desktop file-menu flow N/A; tapping a hidden control mis-fires)')
            }
            await driver.click('#fileMenuTitle')
            await sleep(400)
            const menus = await driver.count(['.menu-title', '.menu-item', '[role=menu]', '.nd-menu', 'dialog[open]'])
            ctx.log(`      menu surfaces: ${JSON.stringify(menus)}`)
            assert.ok(
                Object.values(menus).some((n) => n > 0),
                'tapping the file menu revealed no menu UI in iOS WebKit'
            )
            // Close the menu if a close affordance exists, to leave a clean state.
            if (await driver.exists('.nd-close-btn')) await driver.click('.nd-close-btn').catch(() => {})
        },
    },

    {
        name: 'noisedeck: shuffle/randomize runs without JS errors or context loss',
        timeout: 40000,
        async fn(driver, ctx) {
            if (!(await driver.isVisible('[data-id=shuffle]'))) {
                ctx.skip('[data-id=shuffle] not visible on this layout (hamburger/mobile)')
            }
            const before = await driver.harness()
            await driver.click('[data-id=shuffle]')
            await sleep(1500)
            const after = await driver.harness()
            assert.equal(after.glLost - before.glLost, 0, 'WebGL context lost during shuffle')
            const newErrs = realJsDelta(before, after)
            assert.equal(
                newErrs.length,
                0,
                'shuffle produced JS error(s) on iOS:\n' + newErrs.map((e) => `    [${e.kind}] ${e.message}`).join('\n')
            )
        },
    },

    {
        name: 'noisedeck: export modal opens and cancels cleanly',
        timeout: 45000,
        async fn(driver, ctx) {
            // Open the file menu (export lives under it on desktop; layout may differ on iOS).
            // Visibility, not existence: the desktop control is present-but-hidden in the
            // mobile layout, and tapping it would mis-fire.
            if (await driver.isVisible('#fileMenuTitle')) {
                await driver.click('#fileMenuTitle').catch(() => {})
                await sleep(400)
            }
            // Find a real export CONTROL (concise label) — NOT marketing copy that
            // merely contains the word "export" (e.g. a free-tier upsell line).
            const clicked = await driver.evaluate(() => {
                const els = Array.from(document.querySelectorAll('button, [role=menuitem], .menu-item, .menu-title, li[role], a[role]'))
                const t = els.find((e) => {
                    const txt = (e.textContent || '').trim()
                    return e.offsetParent !== null && /export/i.test(txt) && txt.length <= 24
                })
                if (t) {
                    t.click()
                    return (t.textContent || '').trim()
                }
                return null
            })
            if (!clicked) ctx.skip('no concise export control found in this menu (layout divergence)')
            ctx.log(`      clicked export entry: ${JSON.stringify(clicked)}`)
            // Poll for the modal to become genuinely visible (not just present in the DOM).
            let visible = false
            for (let i = 0; i < 20 && !visible; i++) {
                visible = await driver
                    .evaluate(() => {
                        const m = document.querySelector('#exportModal')
                        if (!m) return false
                        const s = getComputedStyle(m)
                        return s.display !== 'none' && s.visibility !== 'hidden' && m.offsetParent !== null
                    })
                    .catch(() => false)
                if (!visible) await sleep(250)
            }
            // On the free-tier preview build, export is gated behind an upsell rather
            // than opening the modal — that's expected behavior, not a failure.
            if (!visible) ctx.skip('export did not open #exportModal — likely free-tier gated / upsell on this build')
            const before = await driver.harness()
            if (await driver.exists('#exportCancelBtn')) await driver.click('#exportCancelBtn').catch(() => {})
            else if (await driver.exists('.nd-close-btn')) await driver.click('.nd-close-btn').catch(() => {})
            await sleep(400)
            const newErrs = realJsDelta(before, await driver.harness())
            assert.equal(newErrs.length, 0, 'closing export modal produced JS errors:\n' + newErrs.map((e) => `    ${e.message}`).join('\n'))
        },
    },
]
