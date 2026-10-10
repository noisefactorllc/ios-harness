'use strict'

/**
 * Self-tests for the harness's own logic — everything that does NOT require a
 * booted Simulator. Run with: npm run selftest  (node --test tests/*.test.js)
 *
 * These give real regression coverage of the registry, the trap-injecting
 * server, error classification, spec loading and summary formatting today,
 * independent of Xcode.
 */

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const products = require('../lib/products')
const server = require('../lib/server')
const errors = require('../lib/errors')
const runner = require('../lib/runner')
const probes = require('../lib/probes')

function get(url, headers = {}, agent) {
    return new Promise((resolve, reject) => {
        http
            .get(url, { headers, agent }, (res) => {
                let b = ''
                res.on('data', (d) => (b += d))
                res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }))
            })
            .on('error', reject)
    })
}

test('registry: all products resolve with index.html', () => {
    assert.equal(products.allKeys().length, 8) // visualize is desktop-only, excluded
    assert.ok(!products.allKeys().includes('visualize'), 'visualize must not be in the iOS harness')
    for (const p of products.PRODUCTS) {
        assert.ok(fs.existsSync(p.repoPath), `${p.key} repo missing: ${p.repoPath}`)
        assert.ok(fs.existsSync(p.webRootPath), `${p.key} webRoot missing: ${p.webRootPath}`)
        assert.ok(fs.existsSync(path.join(p.webRootPath, 'index.html')), `${p.key} index.html missing`)
        assert.ok(p.primarySelector && p.capabilities && p.ready, `${p.key} incomplete registry entry`)
    }
})

test('registry: resolve() selects all or a subset, throws on unknown', () => {
    assert.equal(products.resolve().length, 8)
    assert.equal(products.resolve(['noisedeck']).length, 1)
    assert.equal(products.resolve(['noisedeck', 'layers']).length, 2)
    assert.throws(() => products.resolve(['does-not-exist']), /Unknown product/)
})

test('errors: classifyErrors separates real JS breakage from network noise', () => {
    const { realJs, networkish } = errors.classifyErrors([
        { kind: 'error', message: "TypeError: undefined is not an object" },
        { kind: 'console.error', message: 'WebGL: INVALID_OPERATION' },
        { kind: 'resource', message: 'failed to load https://cdn.example/x.png' },
        { kind: 'unhandledrejection', message: 'fetch failed for /api/user' },
    ])
    assert.equal(realJs.length, 2, 'TypeError + WebGL console.error are real')
    assert.equal(networkish.length, 2, 'resource load + /api fetch are networkish')
})

test('errors: realJsDelta returns only errors added between snapshots', () => {
    const before = { errorCount: 1, errors: [{ kind: 'error', message: 'old' }] }
    const after = {
        errorCount: 3,
        errors: [
            { kind: 'error', message: 'old' },
            { kind: 'resource', message: 'load https://x/y' },
            { kind: 'error', message: 'TypeError: boom' },
        ],
    }
    const delta = errors.realJsDelta(before, after)
    assert.equal(delta.length, 1)
    assert.match(delta[0].message, /boom/)
})

test('errors: realJsDelta still sees new errors once the capture window is full (>50)', () => {
    // harnessState returns the most recent 50 entries while errorCount keeps
    // the true total — a window that has slid past the older errors must not
    // hide genuinely new breakage (the old head-based slice returned []).
    const window = Array.from({ length: 50 }, (_, i) => ({ kind: 'error', message: `noise ${i}` }))
    const before = { errorCount: 60, errors: window }
    const afterErrors = window.slice(1)
    afterErrors.push({ kind: 'error', message: 'TypeError: boom' })
    const after = { errorCount: 61, errors: afterErrors }
    const delta = errors.realJsDelta(before, after)
    assert.equal(delta.length, 1)
    assert.match(delta[0].message, /boom/)
})

test('errors: realJsDelta returns nothing when errorCount goes backwards (page reloaded)', () => {
    const before = { errorCount: 12, errors: [] }
    const after = { errorCount: 3, errors: [{ kind: 'error', message: 'TypeError: fresh' }] }
    assert.deepEqual(errors.realJsDelta(before, after), [])
})

test('probes: harnessState returns the most recent errors and the true total', () => {
    const H = { errors: [], warnings: [], glContexts: [], audioContexts: [], gestures: 0 }
    for (let i = 0; i < 60; i++) H.errors.push({ kind: 'error', message: `e${i}` })
    for (let i = 0; i < 40; i++) H.warnings.push(`w${i}`)
    global.window = { __iosHarness: H }
    try {
        const h = probes.harnessState()
        assert.equal(h.present, true)
        assert.equal(h.errorCount, 60)
        assert.equal(h.errors.length, 50)
        assert.equal(h.errors[h.errors.length - 1].message, 'e59')
        assert.equal(h.warnings.length, 30)
        assert.equal(h.warnings[h.warnings.length - 1], 'w39')
    } finally {
        delete global.window
    }
})

test('server: injectTrap inserts the shim inside <head> before app scripts', () => {
    const html = '<!doctype html><html><head><title>x</title><script src="app.js"></script></head><body></body></html>'
    const out = server.injectTrap(html)
    const trapPos = out.indexOf('data-ios-harness')
    const headPos = out.search(/<head[^>]*>/i)
    const appScript = out.indexOf('app.js')
    assert.ok(trapPos > headPos && trapPos < appScript, 'trap must be inside head, before app.js')
    assert.match(out, /window\.__iosHarness/)
})

test('server: injectTrap prepends when there is no <head>', () => {
    const out = server.injectTrap('<div>no head here</div>')
    assert.ok(out.indexOf('data-ios-harness') < out.indexOf('<div>'))
})

test('server: parsePortPool reads ranges, singles, and rejects garbage', () => {
    assert.deepEqual(server.parsePortPool('43117-43119'), [43117, 43118, 43119])
    assert.deepEqual(server.parsePortPool('43117, 43120'), [43117, 43120])
    assert.deepEqual(server.parsePortPool('43117-43118,43125'), [43117, 43118, 43125])
    assert.deepEqual(server.parsePortPool(undefined), [])
    assert.deepEqual(server.parsePortPool(''), [])
    // Bad input fails fast (naming the entry) instead of silently degrading
    // to bind(0), which cannot work on the sandboxed hosts this targets.
    for (const bad of ['not a pool', '43117-', '10-3', '0', '700000', '43117,']) {
        assert.throws(() => server.parsePortPool(bad), /NF_PORT_POOL/, `"${bad}" must throw`)
    }
})

test('server: getFreePort picks bindable ports from NF_PORT_POOL when set', async () => {
    const net = require('node:net')
    const bindable = (port) =>
        new Promise((resolve) => {
            const s = net.createServer()
            s.once('error', () => resolve(false))
            s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
        })
    // Unset: ephemeral port, unrelated to any pool.
    process.env.NF_PORT_POOL = ''
    const ephemeral = await server.getFreePort()
    assert.ok(ephemeral > 0)
    // Find a 3-port pool that is actually free, so a foreign listener on a
    // shared host cannot make rotation hand out a duplicate.
    let pool = null
    outer: for (let base = 43100; base < 44100 && !pool; base += 7) {
        for (const p of [base, base + 1, base + 2]) {
            if (!(await bindable(p))) continue outer
        }
        pool = [base, base + 1, base + 2]
    }
    assert.ok(pool, 'no free 3-port pool found for the test')
    process.env.NF_PORT_POOL = pool.join(',')
    try {
        const picked = new Set()
        for (let i = 0; i < 3; i++) {
            const port = await server.getFreePort()
            assert.ok(pool.includes(port), `port ${port} must come from the pool`)
            picked.add(port)
        }
        assert.equal(picked.size, 3, 'rotation must not hand out the same port while it is in use')
    } finally {
        process.env.NF_PORT_POOL = ''
    }
})

test('driver: extraCapabilities merges NF_APPIUM_CAPABILITIES over the defaults', () => {
    const driverLib = require('../lib/driver')
    const env = {}
    assert.deepEqual(driverLib.extraCapabilities(env), {})
    env.NF_APPIUM_CAPABILITIES = '{"appium:webdriverAgentPort":43125,"appium:platformVersion":"99"}'
    assert.deepEqual(driverLib.extraCapabilities(env), {
        'appium:webdriverAgentPort': 43125,
        // a set key overrides the default; defaults not named stay untouched
        'appium:platformVersion': '99',
    })
    env.NF_APPIUM_CAPABILITIES = '[]'
    assert.throws(() => driverLib.extraCapabilities(env), /must be a JSON object/)
    env.NF_APPIUM_CAPABILITIES = '{not json'
    assert.throws(() => driverLib.extraCapabilities(env), /must be a JSON object/)
})

test('driver: ensureForeground focuses the served tab', async () => {
    const driverLib = require('../lib/driver')
    const OURS = 'http://127.0.0.1:43210/app/'
    function fakeBrowser(handles, urlFor) {
        let current = handles[0]
        const switches = []
        return {
            switches,
            getWindowHandles: async () => [...handles],
            getWindowHandle: async () => current,
            switchToWindow: async (h) => {
                if (!handles.includes(h)) throw new Error('no such window')
                switches.push(h)
                current = h
            },
            getUrl: async () => urlFor(current),
        }
    }

    // Our tab sits mid-list: probe a, land on b, stop (c is never touched).
    const b = fakeBrowser(['a', 'b', 'c'], (h) =>
        h === 'b' ? OURS : 'http://foreign.example/other')
    const d1 = driverLib.makeDriver(b)
    assert.equal(await d1.ensureForeground(OURS), 3)
    assert.deepEqual(b.switches, ['a', 'b'])
    assert.equal(await b.getWindowHandle(), 'b')

    // No tab carries the served host: the entry window is restored instead of
    // stranding focus on the last handle probed.
    const b2 = fakeBrowser(['a', 'b', 'c'], () => 'http://foreign.example/other')
    const d2 = driverLib.makeDriver(b2)
    await d2.ensureForeground(OURS)
    assert.deepEqual(b2.switches, ['a', 'b', 'c', 'a'])
    assert.equal(await b2.getWindowHandle(), 'a')

    // Unparseable URL: nothing to match on — no focus shuffling at all.
    const b3 = fakeBrowser(['a', 'b'], () => 'http://foreign.example/other')
    const d3 = driverLib.makeDriver(b3)
    await d3.ensureForeground('not a url')
    assert.deepEqual(b3.switches, [])
})

test('server: serveStatic serves, injects, supports Range, blocks traversal', async () => {
    const nd = products.BY_KEY.get('noisedeck')
    const srv = await server.serveStatic({ webRoot: nd.webRootPath, inject: true })
    try {
        const idx = await get(srv.url + '/')
        assert.equal(idx.status, 200)
        assert.match(idx.body, /data-ios-harness="trap"/)

        const files = fs.readdirSync(nd.webRootPath)
        const asset = files.find((f) => f.endsWith('.js'))
        if (asset) {
            const full = await get(srv.url + '/' + asset)
            assert.equal(full.status, 200)
            assert.equal(full.headers['accept-ranges'], 'bytes')
            const part = await get(srv.url + '/' + asset, { Range: 'bytes=0-3' })
            assert.equal(part.status, 206)
            assert.match(part.headers['content-range'] || '', /^bytes 0-3\//)
        }

        const trav = await get(srv.url + '/../../package.json')
        assert.ok(trav.status === 403 || trav.status === 404, 'path traversal must be blocked')
    } finally {
        await srv.close()
    }
})

test('server: serveStatic resolves suffix byte ranges from the end of the file', async () => {
    const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-harness-range-'))
    fs.writeFileSync(path.join(webRoot, 'media.bin'), '0123456789')
    const srv = await server.serveStatic({ webRoot, inject: false })
    try {
        const suffix = await get(srv.url + '/media.bin', { Range: 'bytes=-3' })
        assert.equal(suffix.status, 206)
        assert.equal(suffix.headers['content-range'], 'bytes 7-9/10')
        assert.equal(suffix.body, '789')

        const oversized = await get(srv.url + '/media.bin', { Range: 'bytes=-20' })
        assert.equal(oversized.status, 206)
        assert.equal(oversized.headers['content-range'], 'bytes 0-9/10')
        assert.equal(oversized.body, '0123456789')
    } finally {
        await srv.close()
        fs.rmSync(webRoot, { recursive: true })
    }
})

test('server: serveStatic close() resolves while an idle keep-alive connection is open', async () => {
    const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-harness-close-'))
    fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><html><body>hi</body></html>')
    const srv = await server.serveStatic({ webRoot, inject: false })
    const agent = new http.Agent({ keepAlive: true })
    try {
        await get(srv.url + '/', {}, agent) // leaves one idle keep-alive socket open
        const closed = srv.close()
        await Promise.race([
            closed,
            new Promise((_, reject) => {
                const t = setTimeout(() => reject(new Error('close() did not resolve with an idle keep-alive connection open')), 5000)
                t.unref()
            }),
        ])
    } finally {
        agent.destroy()
        await srv.close().catch(() => {})
        fs.rmSync(webRoot, { recursive: true })
    }
})

test('server: serveNode close() resolves when the child already exited', async () => {
    const serverScript = `
        const http = require('node:http')
        const s = http.createServer((req, res) => { res.writeHead(200); res.end('ok') })
        s.listen(Number(process.env.PORT), process.env.HOST || '127.0.0.1', () => {
            setTimeout(() => process.exit(0), 300)
        })
    `
    const srv = await server.serveNode({
        repoPath: os.tmpdir(),
        serve: { type: 'node', cmd: process.execPath, args: ['-e', serverScript], readyPath: '/', portEnv: 'PORT' },
    })
    try {
        // Wait until the child has actually exited (its port stops answering).
        const deadline = Date.now() + 10000
        while (Date.now() < deadline) {
            const up = await new Promise((resolve) => {
                const req = http.get(srv.url + '/', (res) => {
                    res.resume()
                    resolve(true)
                })
                req.on('error', () => resolve(false))
                req.setTimeout(1000, () => {
                    req.destroy()
                    resolve(false)
                })
            })
            if (!up) break
            await new Promise((r) => setTimeout(r, 200))
        }
        assert.ok(Date.now() < deadline, 'test child did not exit within 10s')

        const closed = srv.close()
        await Promise.race([
            closed,
            new Promise((_, reject) => {
                const t = setTimeout(() => reject(new Error('close() did not resolve after the child exited')), 5000)
                t.unref()
            }),
        ])
    } finally {
        await srv.close().catch(() => {})
    }
})

test('runner: loadSpecs composes shared + per-product, sharedOnly trims', () => {
    const full = runner.loadSpecs('noisedeck')
    const sharedOnly = runner.loadSpecs('noisedeck', true)
    assert.ok(full.length > sharedOnly.length, 'noisedeck adds its own specs')
    for (const s of full) {
        assert.equal(typeof s.name, 'string')
        assert.equal(typeof s.fn, 'function')
    }
    // a key with no spec file falls back to shared only
    assert.equal(runner.loadSpecs('__no_such_product__').length, sharedOnly.length)
})

test('runner: summarize + formatSummary report pass/fail correctly', () => {
    const byProduct = {
        noisedeck: [
            { name: 'a', status: 'pass' },
            { name: 'b', status: 'skip', reason: 'n/a' },
        ],
        layers: [{ name: 'c', status: 'fail', error: 'boom' }],
    }
    const sum = runner.summarize(byProduct, '/tmp/run')
    assert.equal(sum.ok, false)
    assert.deepEqual(sum.totals, { pass: 1, fail: 1, skip: 1 })
    const text = runner.formatSummary(sum)
    assert.match(text, /✗ FAIL/)
    assert.match(text, /boom/)
})
