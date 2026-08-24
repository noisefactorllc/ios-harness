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

function get(url, headers = {}) {
    return new Promise((resolve, reject) => {
        http
            .get(url, { headers }, (res) => {
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
