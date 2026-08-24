'use strict'

/**
 * Local web server for a product under test.
 *
 *  - serveStatic(): a minimal static file server over a product's web root, with
 *    two features the iOS Simulator needs:
 *      1. injects the in-page instrumentation shim (browser/trap.js) as the first
 *         <script> in served HTML, so load-time errors are captured;
 *      2. supports HTTP Range requests — iOS Safari requires them to play
 *         <audio>/<video>.
 *  - serveNode(): boots a product's own node server (e.g. foundry, for real CSP)
 *    and waits until a readiness path returns 2xx/3xx.
 *
 * The Simulator shares the host network, so http://127.0.0.1:<port> is reachable
 * from Mobile Safari inside the Simulator.
 */

const http = require('node:http')
const net = require('node:net')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')

const TRAP_SRC = fs.readFileSync(path.join(__dirname, '..', 'browser', 'trap.js'), 'utf8')
const TRAP_TAG = `<script data-ios-harness="trap">\n${TRAP_SRC}\n</script>`

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.glsl': 'text/plain; charset=utf-8',
    '.frag': 'text/plain; charset=utf-8',
    '.vert': 'text/plain; charset=utf-8',
}

function contentType(file) {
    return CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream'
}

function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer()
        srv.unref()
        srv.on('error', reject)
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address()
            srv.close(() => resolve(port))
        })
    })
}

/** Inject the trap shim as the first script inside <head> (or prepend if no head). */
function injectTrap(html) {
    const headOpen = /<head[^>]*>/i
    if (headOpen.test(html)) {
        return html.replace(headOpen, (m) => `${m}\n${TRAP_TAG}`)
    }
    const htmlOpen = /<html[^>]*>/i
    if (htmlOpen.test(html)) {
        return html.replace(htmlOpen, (m) => `${m}\n${TRAP_TAG}`)
    }
    return `${TRAP_TAG}\n${html}`
}

function resolveSafe(webRoot, urlPath) {
    const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0])
    let rel = decoded.replace(/^\/+/, '')
    if (rel === '' || rel.endsWith('/')) rel += 'index.html'
    const abs = path.resolve(webRoot, rel)
    const rootAbs = path.resolve(webRoot)
    // Prevent path traversal outside the web root.
    if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null
    return abs
}

/**
 * Serve a static web root.
 * @returns {Promise<{url, port, root, close}>}
 */
async function serveStatic({ webRoot, inject = true, host = '127.0.0.1' }) {
    const root = path.resolve(webRoot)
    const port = await getFreePort()

    const server = http.createServer(async (req, res) => {
        try {
            let abs = resolveSafe(root, req.url || '/')
            if (!abs) {
                res.writeHead(403).end('forbidden')
                return
            }
            let stat
            try {
                stat = await fsp.stat(abs)
                if (stat.isDirectory()) {
                    abs = path.join(abs, 'index.html')
                    stat = await fsp.stat(abs)
                }
            } catch {
                res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
                return
            }

            const type = contentType(abs)
            const isHtml = type.startsWith('text/html')

            if (isHtml && inject) {
                const raw = await fsp.readFile(abs, 'utf8')
                const body = Buffer.from(injectTrap(raw), 'utf8')
                res.writeHead(200, {
                    'content-type': type,
                    'content-length': body.length,
                    'cache-control': 'no-store',
                })
                res.end(body)
                return
            }

            // Range support (iOS Safari media).
            const range = req.headers.range
            if (range) {
                const m = /bytes=(\d*)-(\d*)/.exec(range)
                if (m) {
                    const total = stat.size
                    let start = m[1] ? parseInt(m[1], 10) : 0
                    let end = m[2] ? parseInt(m[2], 10) : total - 1
                    if (!m[1] && m[2]) {
                        start = Math.max(total - parseInt(m[2], 10), 0)
                        end = total - 1
                    }
                    if (Number.isNaN(start)) start = 0
                    if (Number.isNaN(end) || end >= total) end = total - 1
                    if (start > end || start >= total) {
                        res.writeHead(416, { 'content-range': `bytes */${total}` }).end()
                        return
                    }
                    res.writeHead(206, {
                        'content-type': type,
                        'content-range': `bytes ${start}-${end}/${total}`,
                        'accept-ranges': 'bytes',
                        'content-length': end - start + 1,
                        'cache-control': 'no-store',
                    })
                    fs.createReadStream(abs, { start, end }).pipe(res)
                    return
                }
            }

            res.writeHead(200, {
                'content-type': type,
                'content-length': stat.size,
                'accept-ranges': 'bytes',
                'cache-control': 'no-store',
            })
            fs.createReadStream(abs).pipe(res)
        } catch (err) {
            res.writeHead(500, { 'content-type': 'text/plain' }).end('server error: ' + err.message)
        }
    })

    await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, resolve)
    })

    return {
        url: `http://${host}:${port}`,
        port,
        root,
        close: () => new Promise((resolve) => server.close(resolve)),
    }
}

async function waitForReady(url, { timeout = 30000, interval = 300 } = {}) {
    const deadline = Date.now() + timeout
    let lastErr
    while (Date.now() < deadline) {
        try {
            const ok = await new Promise((resolve) => {
                const req = http.get(url, (res) => {
                    res.resume()
                    resolve(res.statusCode >= 200 && res.statusCode < 400)
                })
                req.on('error', (e) => {
                    lastErr = e
                    resolve(false)
                })
                req.setTimeout(2000, () => {
                    req.destroy()
                    resolve(false)
                })
            })
            if (ok) return true
        } catch (e) {
            lastErr = e
        }
        await new Promise((r) => setTimeout(r, interval))
    }
    throw new Error(`server did not become ready at ${url} within ${timeout}ms (${lastErr || 'no response'})`)
}

/**
 * Boot a product's own node server.
 * @returns {Promise<{url, port, close}>}
 */
async function serveNode({ repoPath, serve, host = '127.0.0.1' }) {
    const port = await getFreePort()
    const env = { ...process.env, ...(serve.env || {}) }
    if (serve.portEnv) env[serve.portEnv] = String(port)
    env.HOST = host

    const child = spawn(serve.cmd, serve.args || [], {
        cwd: repoPath,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    const logs = []
    child.stdout.on('data', (d) => logs.push(d.toString()))
    child.stderr.on('data', (d) => logs.push(d.toString()))

    const url = `http://${host}:${port}`
    const readyUrl = url + (serve.readyPath || '/')
    try {
        await waitForReady(readyUrl)
    } catch (err) {
        child.kill('SIGKILL')
        throw new Error(`${serve.cmd} ${(serve.args || []).join(' ')} failed to start.\n${logs.join('').slice(-2000)}\n${err.message}`)
    }

    return {
        url,
        port,
        // Trap is not server-injected for node-served products; driver injects post-load.
        injectsTrap: false,
        close: () =>
            new Promise((resolve) => {
                child.once('close', () => resolve())
                child.kill('SIGTERM')
                setTimeout(() => child.kill('SIGKILL'), 3000)
            }),
    }
}

/** Serve a product per its registry entry, falling back to static if its own
 *  server can't boot (e.g. its deps aren't installed). */
async function serveProduct(product) {
    if (product.serve.type === 'node') {
        try {
            return await serveNode({ repoPath: product.repoPath, serve: product.serve })
        } catch (err) {
            // Robust + honest: serve the web root statically so the front-end is
            // still exercised; flag that the real server (and its CSP) was not run.
            const srv = await serveStatic({ webRoot: product.webRootPath, inject: true })
            srv.serverFellBack = String((err && err.message) || err).split('\n')[0]
            return srv
        }
    }
    return serveStatic({ webRoot: product.webRootPath, inject: true })
}

module.exports = { serveStatic, serveNode, serveProduct, waitForReady, getFreePort, injectTrap, TRAP_SRC }
