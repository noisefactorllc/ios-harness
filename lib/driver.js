'use strict'

/**
 * Appium server lifecycle + the iOS WebKit driver.
 *
 *  - startAppiumServer(): spawns the package-local Appium 2 server (subprocess,
 *    isolated APPIUM_HOME) and waits for /status to report ready.
 *  - createIosSession(): a WebdriverIO session with the XCUITest driver targeting
 *    Mobile Safari, attached to a simctl-booted device by UDID.
 *  - makeDriver(): wraps the WebdriverIO browser in a small IosDriver surface the
 *    specs use (goto / waitFor / click / type / evaluate / native taps / probes).
 *
 * WebdriverIO v9 is ESM-only; we load it with dynamic import() from this CJS file.
 */

const { spawn } = require('node:child_process')
const http = require('node:http')
const path = require('node:path')
const simulator = require('./simulator')
const probes = require('./probes')
const { getFreePort, TRAP_SRC } = require('./server')

const PKG_ROOT = path.resolve(__dirname, '..')
const APPIUM_HOME = process.env.APPIUM_HOME || path.join(PKG_ROOT, '.appium')
const APPIUM_BIN = path.join(PKG_ROOT, 'node_modules', '.bin', 'appium')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function httpGetJson(url, timeout = 2500) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let b = ''
            res.on('data', (d) => (b += d))
            res.on('end', () => {
                try {
                    resolve(JSON.parse(b))
                } catch (e) {
                    reject(e)
                }
            })
        })
        req.on('error', reject)
        req.setTimeout(timeout, () => {
            req.destroy()
            reject(new Error('timeout'))
        })
    })
}

async function startAppiumServer({ port, host = '127.0.0.1' } = {}) {
    const p = port || (await getFreePort())
    const env = { ...process.env, APPIUM_HOME }
    const args = [
        '--port', String(p),
        '--address', host,
        '--base-path', '/',
        // Raise for debugging webview detection etc.: NF_APPIUM_LOG_LEVEL=debug
        '--log-level', process.env.NF_APPIUM_LOG_LEVEL || 'warn',
        '--relaxed-security',
    ]
    const child = spawn(APPIUM_BIN, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const logs = []
    const collect = (d) => {
        logs.push(d.toString())
        if (logs.length > 400) logs.shift()
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)

    const base = `http://${host}:${p}`
    const deadline = Date.now() + 60000
    let ready = false
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`Appium server exited early (code ${child.exitCode}):\n${logs.join('').slice(-2000)}`)
        }
        const status = await httpGetJson(base + '/status').catch(() => null)
        if (status && status.value && (status.value.ready === undefined || status.value.ready)) {
            ready = true
            break
        }
        await sleep(400)
    }
    if (!ready) {
        child.kill('SIGKILL')
        throw new Error(`Appium server did not become ready:\n${logs.join('').slice(-2000)}`)
    }

    return {
        url: base,
        port: p,
        logs,
        stop: () =>
            new Promise((resolve) => {
                child.once('close', resolve)
                child.kill('SIGTERM')
                setTimeout(() => child.kill('SIGKILL'), 3000)
            }),
    }
}

async function createIosSession({ appiumUrl, udid, platformVersion, deviceName, initialUrl = 'about:blank' }) {
    const { remote } = await import('webdriverio')
    const u = new URL(appiumUrl)
    const browser = await remote({
        protocol: u.protocol.replace(':', ''),
        hostname: u.hostname,
        port: Number(u.port),
        path: '/',
        logLevel: 'error',
        connectionRetryTimeout: 600000,
        capabilities: {
            platformName: 'iOS',
            'appium:automationName': 'XCUITest',
            'appium:udid': udid,
            'appium:deviceName': deviceName,
            'appium:platformVersion': platformVersion,
            'appium:browserName': 'Safari',
            'appium:nativeWebTap': true,
            'appium:safariInitialUrl': initialUrl,
            'appium:newCommandTimeout': 180,
            'appium:wdaLaunchTimeout': 600000,
            'appium:wdaConnectionTimeout': 600000,
            'appium:webviewConnectTimeout': 30000,
            // Fail fast (not the 120s default) when the webview's JS is blocked —
            // e.g. an interaction opened an in-app browser / native modal over the
            // page. Keeps one wedged interaction from burning minutes per spec.
            'appium:webviewAtomWaitTimeout': 30000,
            // Clean single-tab Safari per product session — prevents tab
            // accumulation that backgrounds the app-under-test (iOS suspends
            // WebGL/rAF in background tabs) and avoids stale SW/cache carryover.
            'appium:noReset': false,
        },
    })
    // XCUITest can default the async-script timeout to ~0ms, which breaks
    // executeAsync probes (canvas/audio). Set sane W3C timeouts explicitly.
    await browser.setTimeout({ script: 30000, pageLoad: 60000 }).catch(() => {})
    return browser
}

/**
 * A WebdriverIO session attached to a STANDALONE native app (Capacitor WKWebView
 * wrapper) rather than Mobile Safari. `appium:app` makes Appium install + launch
 * the .app; we start in NATIVE_APP and switch to the WKWebView context manually
 * (autoWebview:false) so we can poll for it to register. Same XCUITest driver,
 * same device — only the app under test differs, so the existing specs run as-is.
 */
async function createNativeSession({ appiumUrl, udid, platformVersion, deviceName, appPath }) {
    const { remote } = await import('webdriverio')
    const u = new URL(appiumUrl)
    const browser = await remote({
        protocol: u.protocol.replace(':', ''),
        hostname: u.hostname,
        port: Number(u.port),
        path: '/',
        logLevel: 'error',
        connectionRetryTimeout: 600000,
        capabilities: {
            platformName: 'iOS',
            'appium:automationName': 'XCUITest',
            'appium:udid': udid,
            'appium:deviceName': deviceName,
            'appium:platformVersion': platformVersion,
            'appium:app': appPath,
            // Capacitor names its Xcode target "App", so the Web Inspector reports
            // the WKWebView's owning process as "process-App" — NOT the app's bundle
            // id. Appium's default match list misses it and probes the (empty)
            // WebKit.WebContent process instead, so it never finds the page. Tell it
            // to also match process-App (universal across our Capacitor builds).
            'appium:additionalWebviewBundleIds': ['process-App'],
            // Start native; we switch to the webview ourselves (with polling).
            'appium:autoWebview': false,
            'appium:noReset': false,
            'appium:fullReset': false,
            'appium:newCommandTimeout': 180,
            'appium:wdaLaunchTimeout': 600000,
            'appium:wdaConnectionTimeout': 600000,
            'appium:webviewConnectTimeout': 30000,
            // Fail fast (not the 120s default) when the webview's JS is blocked —
            // e.g. a tap opened an in-app browser (SFSafariViewController) over the
            // page. Keeps one wedged interaction from burning minutes per spec.
            'appium:webviewAtomWaitTimeout': 30000,
            // We're not in Safari — don't let Safari webviews leak into the list.
            'appium:includeSafariInWebviews': false,
        },
    })
    await browser.setTimeout({ script: 30000, pageLoad: 60000 }).catch(() => {})
    return browser
}

function makeDriver(browser, { udid, mode = 'web' } = {}) {
    const native = mode === 'native'

    async function ensureWebContext() {
        const cur = await browser.getContext().catch(() => null)
        if (cur && /WEBVIEW|safari/i.test(String(cur))) return cur
        const ctxs = await browser.getContexts().catch(() => [])
        const web = ctxs.find((c) => /WEBVIEW|safari/i.test(String((c && c.id) || c)))
        if (web) await browser.switchContext(web.id || web)
        return browser.getContext().catch(() => null)
    }

    /**
     * Native apps register their WKWebView context a beat after launch (WDA
     * attach + page load). Poll getContexts until a WEBVIEW appears, switch to
     * it, and confirm the DOM is reachable. Throws if no webview ever registers
     * (a real failure — the standalone build didn't load its web content).
     */
    async function ensureWebview({ timeout = 45000, interval = 500 } = {}) {
        const deadline = Date.now() + timeout
        let lastCtxs = []
        while (Date.now() < deadline) {
            lastCtxs = await browser.getContexts().catch(() => [])
            const web = lastCtxs.find((c) => /WEBVIEW/i.test(String((c && c.id) || c)))
            if (web) {
                await browser.switchContext((web && web.id) || web).catch(() => {})
                const ready = await browser.execute(() => typeof document !== 'undefined').catch(() => null)
                if (ready) return (web && web.id) || web
            }
            await sleep(interval)
        }
        throw new Error(
            `native app exposed no WKWebView context within ${timeout}ms — the standalone build did not load its web content ` +
                `(contexts seen: ${JSON.stringify(lastCtxs.map((c) => (c && c.id) || c))})`
        )
    }

    const d = {
        browser,
        udid,

        async goto(url) {
            // Native standalone app: there is no URL to navigate to — the app
            // loads its OWN bundled web content. "goto" just attaches us to the
            // WKWebView (and must NOT reload, which would discard the trap shim).
            if (native) {
                await ensureWebview()
                return
            }
            await browser.url(url)
        },
        async currentUrl() {
            return browser.getUrl()
        },
        async title() {
            return browser.getTitle()
        },

        async evaluate(fn, ...args) {
            return browser.execute(fn, ...args)
        },
        async evaluateAsync(fn, ...args) {
            return browser.executeAsync(fn, ...args)
        },

        /** Poll an in-page predicate (function body string returning boolean). */
        async ready(predicateBody, { timeout = 30000, interval = 300 } = {}) {
            const fn = new Function(predicateBody) // eslint-disable-line no-new-func
            const deadline = Date.now() + timeout
            let last
            while (Date.now() < deadline) {
                last = await browser.execute(fn).catch((e) => {
                    return { __err: String(e && e.message) }
                })
                if (last === true) return true
                await sleep(interval)
            }
            throw new Error(`app did not become ready within ${timeout}ms (last predicate result: ${JSON.stringify(last)})`)
        },

        async waitFor(sel, { timeout = 15000, visible = true } = {}) {
            const el = await browser.$(sel)
            await el.waitForExist({ timeout })
            if (visible) await el.waitForDisplayed({ timeout }).catch(() => {})
            return el
        },
        async exists(sel) {
            const el = await browser.$(sel)
            return el.isExisting()
        },
        /**
         * True only if the element exists AND is actually displayed. Interaction
         * guards must use this, not exists(): responsive layouts keep desktop
         * controls in the DOM but hidden (display:none), and nativeWebTap-ing a
         * hidden element mis-taps at a stale screen location (which can hit a
         * neighbouring link / open an in-app browser and wedge the session).
         */
        async isVisible(sel) {
            const el = await browser.$(sel)
            if (!(await el.isExisting().catch(() => false))) return false
            return el.isDisplayed().catch(() => false)
        },

        /**
         * Ensure the instrumentation shim is present. Static products get it at
         * load (server-injected); node-served products (foundry) get it here via
         * the WebDriver bridge — which also bypasses CSP, since bridge-evaluated
         * JS is not subject to the page's script-src. The shim self-guards against
         * double-install, so this is a no-op when already present.
         */
        async installTrap() {
            try {
                await browser.execute(new Function(TRAP_SRC)) // eslint-disable-line no-new-func
            } catch (_) {
                /* eval/CSP edge — load-time injection still covers static products */
            }
            return browser.execute(() => !!window.__iosHarness).catch(() => false)
        },

        /** Set device orientation ('LANDSCAPE' | 'PORTRAIT'). Best-effort. */
        async setOrientation(o) {
            try {
                await browser.setOrientation(o)
                return true
            } catch (e) {
                return { ok: false, reason: e.message }
            }
        },

        /**
         * Bring OUR app's tab to the foreground. iOS Safari suspends WebGL / rAF /
         * timers in background tabs, and session restore can leave a foreign tab
         * in front — which silently breaks rendering even though Appium is attached
         * to the right webview. We switch to the tab
         * whose URL matches the served host:port (switching foregrounds it).
         *
         * We deliberately do NOT closeWindow: wdio's post-close window bookkeeping
         * can call switchToWindow(undefined) and throw synchronously through its
         * event emitter, which escapes try/catch and kills the process.
         */
        async ensureForeground(expectedUrl) {
            // Native standalone app: a single WKWebView, always frontmost — no
            // tabs to foreground. Just make sure we're in the webview context.
            if (native) {
                await ensureWebview()
                return 1
            }
            const handles = await browser.getWindowHandles().catch(() => [])
            if (handles.length <= 1) return handles.length
            let host = null
            try {
                host = new URL(expectedUrl).host
            } catch (_) {}
            for (const h of handles) {
                if (typeof h !== 'string' || !h) continue
                try {
                    await browser.switchToWindow(h)
                    const u = await browser.getUrl()
                    if (host && u && u.includes(host)) break // our tab — now foreground
                } catch (_) {}
            }
            return handles.length
        },

        /** Tap a selector only if it exists (for dismissing boot/autoplay/rotate gates). */
        async tapIfPresent(sel) {
            const el = await browser.$(sel)
            if (!(await el.isExisting().catch(() => false))) return false
            try {
                await el.click()
            } catch (_) {
                await browser.execute((s) => {
                    const x = document.querySelector(s)
                    if (x) x.click()
                }, sel)
            }
            return true
        },

        /** Real native tap on a DOM element (nativeWebTap); JS-click fallback. */
        async click(sel, { timeout = 15000 } = {}) {
            const el = await browser.$(sel)
            await el.waitForExist({ timeout })
            try {
                await el.click()
            } catch (e) {
                await browser.execute((s) => {
                    const x = document.querySelector(s)
                    if (x) x.click()
                }, sel)
            }
            return true
        },
        tapElement(sel, opts) {
            return d.click(sel, opts)
        },
        async type(sel, text, { clear = true } = {}) {
            const el = await browser.$(sel)
            await el.waitForExist()
            if (clear) await el.clearValue().catch(() => {})
            await el.setValue(text)
        },
        async text(sel) {
            const el = await browser.$(sel)
            return el.getText()
        },

        /** Native touch tap at a fraction of the screen (canvas / gesture surfaces). */
        async tapNativeAt(xFrac, yFrac) {
            await browser.switchContext('NATIVE_APP')
            try {
                const { width, height } = await browser.getWindowSize()
                const x = Math.round(width * xFrac)
                const y = Math.round(height * yFrac)
                await browser
                    .action('pointer', { parameters: { pointerType: 'touch' } })
                    .move({ x, y })
                    .down()
                    .pause(60)
                    .up()
                    .perform()
            } finally {
                // Always restore the web context — running a JS probe in NATIVE_APP
                // context hangs executeAsync (no DOM / no done callback).
                await ensureWebContext()
            }
        },

        // Probes
        harness() {
            return browser.execute(probes.harnessState)
        },
        elementInfo(sel) {
            return browser.execute(probes.elementInfo, sel)
        },
        canvasNotBlank(sel) {
            return browser.executeAsync(probes.canvasNotBlank, sel || 'canvas')
        },
        viewportVisibility(sel) {
            return browser.execute(probes.viewportVisibility, sel)
        },
        resumeAudio() {
            return browser.executeAsync(probes.resumeAudio)
        },
        /** { ok, video, audio } — videoinput>0 means a camera is actually present. */
        mediaDevices() {
            return browser.executeAsync(probes.mediaDeviceKinds)
        },
        domDrag(sel, x0, y0, x1, y1) {
            return browser.execute(probes.domDrag, sel, x0, y0, x1, y1)
        },
        count(selectors) {
            return browser.execute(probes.countSelectors, selectors)
        },

        screenshot(outPath) {
            return simulator.screenshot(udid, outPath)
        },
        contexts() {
            return browser.getContexts()
        },
        ensureWebContext,
        ensureWebview,
        mode,
        async quit() {
            try {
                await browser.deleteSession()
            } catch (_) {}
        },
    }
    return d
}

module.exports = { startAppiumServer, createIosSession, createNativeSession, makeDriver, APPIUM_HOME, APPIUM_BIN }
