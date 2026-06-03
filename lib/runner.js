'use strict'

/**
 * Orchestrates an iOS Simulator test run:
 *   ensure toolchain -> resolve+boot device -> start Appium -> for each product:
 *   serve -> create Safari session -> run shared + per-product specs -> collect
 *   artifacts -> tear down. Aggregates a pass/fail/skip summary; exit code is
 *   non-zero on any failure.
 *
 * Spec module contract (specs/shared.js and specs/<key>.js export an array of):
 *   { name, fn: async (driver, ctx) => {}, capability?, timeout? }
 *   - throw to fail; call ctx.skip(reason) to skip; return to pass.
 *   - `capability` (e.g. 'webgl','audio','camera') auto-skips when the product
 *     registry says the product does not use it.
 */

const fs = require('node:fs')
const path = require('node:path')
const products = require('./products')
const simulator = require('./simulator')
const server = require('./server')
const driverLib = require('./driver')
const nativeLib = require('./native')

const PKG_ROOT = path.resolve(__dirname, '..')
const ARTIFACTS = path.join(PKG_ROOT, 'artifacts')

class SkipError extends Error {
    constructor(reason) {
        super(reason)
        this.isSkip = true
    }
}

function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
}

function stamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

function withTimeout(promise, ms, label) {
    let t
    const timeout = new Promise((_, reject) => {
        t = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms)
    })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t))
}

function loadSpecs(productKey, sharedOnly = false) {
    const shared = require('../specs/shared.js')
    if (sharedOnly) return [...shared]
    let specific = []
    const specPath = path.join(PKG_ROOT, 'specs', `${productKey}.js`)
    if (fs.existsSync(specPath)) {
        specific = require(specPath)
    }
    return [...shared, ...specific]
}

async function runProduct(product, { appium, device, runDir, log, sharedOnly, native = false }) {
    const pArtifacts = path.join(runDir, product.key)
    fs.mkdirSync(pArtifacts, { recursive: true })
    const results = []
    let srv
    let browser
    let driver
    let bundleId

    try {
        let ctx
        if (native) {
            // ── Standalone native build: generate the .app, then drive it. ──
            const built = await nativeLib.buildApp(product, { log })
            bundleId = built.bundleId
            log(`    built ${built.appName}.app (${bundleId})`)
            browser = await driverLib.createNativeSession({
                appiumUrl: appium.url,
                udid: device.udid,
                platformVersion: device.platformVersion,
                deviceName: device.name,
                appPath: built.appPath,
            })
            driver = driverLib.makeDriver(browser, { udid: device.udid, mode: 'native' })
            ctx = {
                product,
                native: true,
                bundleId,
                // Detected in the shared "loads" spec; default false so camera-gated
                // specs behave safely (skip the camera→render path) if loads throws first.
                cameraAvailable: false,
                baseUrl: null,
                // No URL — the native build loads its own bundled assets. The
                // shared "loads" spec passes this to goto(), which native-mode
                // ignores (attaching to the WKWebView instead).
                url: null,
                artifactsDir: pArtifacts,
                log,
                skip: (reason) => {
                    throw new SkipError(reason)
                },
            }
        } else {
            // ── Web build: serve the front-end and drive it in Mobile Safari. ──
            srv = await server.serveProduct(product)
            log(`    served ${product.serve.type} at ${srv.url}`)
            if (srv.serverFellBack) {
                log(`    ⚠ ${product.key} server did not boot (${srv.serverFellBack}); serving static front-end (real CSP not exercised)`)
            }

            // Camera products: pre-grant Safari camera privacy (best-effort).
            if (product.capabilities.camera) {
                await simulator.setPrivacy(device.udid, 'camera', 'com.apple.mobilesafari', true)
            }

            browser = await driverLib.createIosSession({
                appiumUrl: appium.url,
                udid: device.udid,
                platformVersion: device.platformVersion,
                deviceName: device.name,
                initialUrl: srv.url + product.entry,
            })
            driver = driverLib.makeDriver(browser, { udid: device.udid })
            ctx = {
                product,
                server: srv,
                cameraAvailable: false, // detected in the shared "loads" spec
                baseUrl: srv.url,
                url: srv.url + product.entry,
                artifactsDir: pArtifacts,
                log,
                skip: (reason) => {
                    throw new SkipError(reason)
                },
            }
        }

        // Set orientation EXPLICITLY for every product. The Simulator device is
        // reused across runs and retains its last orientation, so a prior
        // landscape product (shade/foundry) would otherwise leave portrait products
        // measured in landscape — skewing viewport checks. Always pin the intended one.
        {
            const want = product.orientation === 'landscape' ? 'LANDSCAPE' : 'PORTRAIT'
            const r = await driver.setOrientation(want)
            log(`    orientation: ${want.toLowerCase()}${r === true ? '' : ` (note: ${JSON.stringify(r)})`}`)
        }

        const specs = loadSpecs(product.key, sharedOnly)
        for (const spec of specs) {
            if (spec.capability && !product.capabilities[spec.capability]) {
                results.push({ name: spec.name, status: 'skip', reason: `capability "${spec.capability}" not used by ${product.key}` })
                log(`    ⊘ ${spec.name} (no ${spec.capability})`)
                continue
            }
            const started = Date.now()
            try {
                await withTimeout(Promise.resolve(spec.fn(driver, ctx)), spec.timeout || 60000, spec.name)
                results.push({ name: spec.name, status: 'pass', ms: Date.now() - started })
                log(`    ✓ ${spec.name}`)
            } catch (e) {
                if (e && e.isSkip) {
                    results.push({ name: spec.name, status: 'skip', reason: e.message })
                    log(`    ⊘ ${spec.name} (skip: ${e.message})`)
                    continue
                }
                const shot = path.join(pArtifacts, `FAIL-${slug(spec.name)}.png`)
                let harness = null
                try {
                    await driver.screenshot(shot)
                } catch (_) {}
                try {
                    harness = await driver.harness()
                } catch (_) {}
                results.push({
                    name: spec.name,
                    status: 'fail',
                    ms: Date.now() - started,
                    error: String((e && e.message) || e),
                    screenshot: fs.existsSync(shot) ? shot : null,
                    inPageErrors: harness && harness.errors,
                })
                log(`    ✗ ${spec.name} — ${String((e && e.message) || e).split('\n')[0]}`)
            }
        }
    } catch (e) {
        results.push({ name: '(product setup)', status: 'fail', error: String((e && e.message) || e) })
        log(`    ✗ setup failed: ${String((e && e.message) || e).split('\n')[0]}`)
    } finally {
        if (driver) await driver.quit().catch(() => {})
        if (srv) await srv.close().catch(() => {})
        if (native && bundleId) await simulator.terminateApp(device.udid, bundleId).catch(() => {})
    }

    return results
}

async function run({ keys, sharedOnly = false, native = false, log = console.log } = {}) {
    let selected = products.resolve(keys)
    if (native) {
        // Native mode only applies to products with a standalone build config.
        const skipped = selected.filter((p) => !p.native)
        selected = selected.filter((p) => p.native)
        if (skipped.length) {
            log(`Native mode: skipping ${skipped.map((p) => p.key).join(', ')} (no standalone iOS build config)`)
        }
        if (selected.length === 0) {
            throw new Error(
                `No native-capable products selected. Native builds exist for: ${products
                    .nativeProducts()
                    .map((p) => p.key)
                    .join(', ')}`
            )
        }
    }
    const runDir = path.join(ARTIFACTS, stamp())
    fs.mkdirSync(runDir, { recursive: true })

    log('Verifying toolchain…')
    await simulator.ensureToolchain()

    const device = await simulator.resolveDevice()
    log(`Device: ${device.name} — ${device.deviceTypeName}, ${device.runtimeName}`)
    log(`Booting ${device.udid}…`)
    await simulator.boot(device.udid)

    log('Starting Appium…')
    const appium = await driverLib.startAppiumServer()
    log(`Appium: ${appium.url}`)

    const byProduct = {}
    try {
        for (const product of selected) {
            const tag = native ? '  [native standalone .app]' : product.backendGated ? '  [front-end only — backend not exercised]' : ''
            log(`\n▶ ${product.title} (${product.key})${tag}`)
            byProduct[product.key] = await runProduct(product, { appium, device, runDir, log, sharedOnly, native })
        }
    } finally {
        await appium.stop().catch(() => {})
    }

    const summary = summarize(byProduct, runDir)
    fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2))
    return summary
}

function summarize(byProduct, runDir) {
    const totals = { pass: 0, fail: 0, skip: 0 }
    for (const key of Object.keys(byProduct)) {
        for (const r of byProduct[key]) totals[r.status] = (totals[r.status] || 0) + 1
    }
    return { ok: totals.fail === 0, totals, byProduct, runDir }
}

function formatSummary(summary) {
    const lines = []
    lines.push('')
    lines.push('═'.repeat(60))
    for (const key of Object.keys(summary.byProduct)) {
        const rs = summary.byProduct[key]
        const p = rs.filter((r) => r.status === 'pass').length
        const f = rs.filter((r) => r.status === 'fail').length
        const s = rs.filter((r) => r.status === 'skip').length
        lines.push(`${f === 0 ? '✓' : '✗'} ${key.padEnd(13)} ${p} pass  ${f} fail  ${s} skip`)
        for (const r of rs.filter((r) => r.status === 'fail')) {
            lines.push(`    ✗ ${r.name}: ${String(r.error).split('\n')[0]}`)
            if (r.inPageErrors && r.inPageErrors.length) {
                lines.push(`        in-page: ${r.inPageErrors.slice(0, 3).map((e) => e.message).join(' | ')}`)
            }
            if (r.screenshot) lines.push(`        shot: ${r.screenshot}`)
        }
    }
    lines.push('─'.repeat(60))
    lines.push(`TOTAL: ${summary.totals.pass} pass, ${summary.totals.fail} fail, ${summary.totals.skip} skip`)
    lines.push(`artifacts: ${summary.runDir}`)
    lines.push(summary.ok ? '✓ PASS' : '✗ FAIL')
    lines.push('═'.repeat(60))
    return lines.join('\n')
}

module.exports = { run, summarize, formatSummary, loadSpecs, SkipError }
