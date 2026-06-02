'use strict'

/** Small helpers shared by per-product specs. */

const { realJsDelta, classifyErrors } = require('./errors')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Poll document.body.innerText until it contains `needle` (case-insensitive). */
async function waitForBodyText(driver, needle, { timeout = 8000, interval = 300 } = {}) {
    const deadline = Date.now() + timeout
    let last = ''
    while (Date.now() < deadline) {
        last = await driver.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '')
        if (last && last.toLowerCase().includes(String(needle).toLowerCase())) return last
        await sleep(interval)
    }
    return null
}

/** Set an <input> value and fire input+change (for range/number/text controls). */
async function setRangeValue(driver, sel, value) {
    return driver.evaluate(
        (s, v) => {
            const el = document.querySelector(s)
            if (!el) return false
            el.value = v
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            return true
        },
        sel,
        String(value)
    )
}

/** Assert the page is still alive/responsive (catches crashes & reloads). */
async function assertAlive(driver) {
    const v = await driver.evaluate(() => 2 + 2).catch(() => null)
    return v === 4
}

module.exports = { sleep, waitForBodyText, setRangeValue, assertAlive, realJsDelta, classifyErrors }
