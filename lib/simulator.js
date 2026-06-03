'use strict'

/**
 * iOS Simulator lifecycle via `xcrun simctl`.
 *
 * This is the pure-simctl layer: it owns the device (resolve/create/boot/erase/
 * screenshot/privacy/openurl/shutdown). Appium attaches to the booted device by
 * UDID — simctl manages the simulator, Appium drives the app inside it.
 *
 * Design rules honored here:
 *  - One attempt per command; surface the real stderr on failure (no blind retry).
 *  - Idempotent boot (booting an already-booted device is fine).
 *  - Deterministic device: a single named device reused across runs.
 */

const { execFile } = require('node:child_process')

const DEVICE_NAME = process.env.NF_IOS_DEVICE_NAME || 'nf-ios-harness'
// Preferred device type / runtime can be pinned via env; otherwise newest available.
const PREFERRED_DEVICE = process.env.NF_IOS_DEVICE || null // e.g. "iPhone 16"
const PREFERRED_RUNTIME = process.env.NF_IOS_RUNTIME || null // e.g. "iOS 18.2"

function run(args, { timeout = 120000 } = {}) {
    return new Promise((resolve, reject) => {
        execFile('xcrun', ['simctl', ...args], { timeout, encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 }, (err, stdout, stderr) => {
            if (err) {
                err.message = `simctl ${args.join(' ')} failed: ${stderr || err.message}`
                err.stdout = stdout
                err.stderr = stderr
                return reject(err)
            }
            resolve({ stdout, stderr })
        })
    })
}

/**
 * Verify the toolchain is present. Throws an actionable error if full Xcode /
 * simctl is missing. Returns { developerDir, simctl: true } on success.
 */
async function ensureToolchain() {
    const { execFileSync } = require('node:child_process')
    let developerDir
    try {
        developerDir = execFileSync('xcode-select', ['-p'], { encoding: 'utf8' }).trim()
    } catch {
        developerDir = '(xcode-select failed)'
    }
    try {
        await run(['help'], { timeout: 15000 })
    } catch (err) {
        const isCLT = /CommandLineTools/.test(developerDir)
        throw new Error(
            'iOS Simulator toolchain not available — `xcrun simctl` is missing.\n' +
                `  active developer dir: ${developerDir}\n` +
                (isCLT
                    ? '  This is Command Line Tools, NOT full Xcode. simctl + the Simulator ship only with Xcode.app.\n'
                    : '') +
                '  Fix: install Xcode (App Store, or `xcodes install --latest`), then:\n' +
                '    sudo xcode-select -s /Applications/Xcode.app/Contents/Developer\n' +
                '    xcodebuild -runFirstLaunch\n' +
                `  (underlying: ${err.stderr || err.message})`
        )
    }
    return { developerDir, simctl: true }
}

async function listJson() {
    const { stdout } = await run(['list', '-j', '-v'])
    return JSON.parse(stdout)
}

function versionTuple(v) {
    return String(v || '0')
        .split('.')
        .map((n) => parseInt(n, 10) || 0)
}

function cmpVersion(a, b) {
    const ta = versionTuple(a)
    const tb = versionTuple(b)
    for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
        const d = (ta[i] || 0) - (tb[i] || 0)
        if (d) return d
    }
    return 0
}

/** Pick the newest available iOS runtime (or the env-pinned one). */
function pickRuntime(list) {
    const iosRuntimes = (list.runtimes || []).filter(
        (r) => r.isAvailable && /iOS/.test(r.name || r.platform || '')
    )
    if (iosRuntimes.length === 0) {
        throw new Error(
            'No available iOS Simulator runtime found.\n' +
                '  Fix: install one, e.g. `xcodebuild -downloadPlatform iOS`\n' +
                '  or via Xcode > Settings > Components.'
        )
    }
    if (PREFERRED_RUNTIME) {
        const match = iosRuntimes.find(
            (r) => r.name === PREFERRED_RUNTIME || r.identifier === PREFERRED_RUNTIME
        )
        if (match) return match
    }
    return iosRuntimes.sort((a, b) => cmpVersion(b.version, a.version))[0]
}

/** Pick a sensible iPhone device type (or the env-pinned one). */
function pickDeviceType(list) {
    const iphones = (list.devicetypes || []).filter(
        (d) => d.productFamily === 'iPhone' || /iPhone/.test(d.name)
    )
    if (iphones.length === 0) throw new Error('No iPhone device types available in this Xcode.')
    if (PREFERRED_DEVICE) {
        const match = iphones.find(
            (d) => d.name === PREFERRED_DEVICE || d.identifier === PREFERRED_DEVICE
        )
        if (match) return match
    }
    // Prefer a plain numbered iPhone (not SE / Plus / Pro / Max), newest model number.
    const score = (d) => {
        const m = /iPhone (\d+)/.exec(d.name)
        const model = m ? parseInt(m[1], 10) : 0
        const plain = !/SE|Plus|Pro|Max|mini/i.test(d.name)
        return model * 10 + (plain ? 5 : 0)
    }
    return iphones.sort((a, b) => score(b) - score(a))[0]
}

function findDevice(list, runtimeId, name) {
    const devices = (list.devices && list.devices[runtimeId]) || []
    return devices.find((d) => d.name === name && d.isAvailable !== false) || null
}

/**
 * Resolve (creating if needed) the harness's named device for the chosen
 * runtime + device type. Returns { udid, name, runtime, deviceType, platformVersion }.
 */
async function resolveDevice() {
    const list = await listJson()
    const runtime = pickRuntime(list)
    const deviceType = pickDeviceType(list)

    let device = findDevice(list, runtime.identifier, DEVICE_NAME)
    if (!device) {
        const { stdout } = await run(['create', DEVICE_NAME, deviceType.identifier, runtime.identifier])
        const udid = stdout.trim()
        device = { udid, name: DEVICE_NAME, state: 'Shutdown' }
    }
    return {
        udid: device.udid,
        name: DEVICE_NAME,
        state: device.state,
        runtime: runtime.identifier,
        runtimeName: runtime.name,
        deviceType: deviceType.identifier,
        deviceTypeName: deviceType.name,
        platformVersion: runtime.version,
    }
}

/** Boot the device if not already booted, and wait until fully booted. */
async function boot(udid) {
    // bootstatus -b boots the device first, then blocks until boot completes.
    await run(['bootstatus', udid, '-b'], { timeout: 300000 })
}

async function shutdown(udid) {
    try {
        await run(['shutdown', udid])
    } catch (err) {
        if (!/current state: Shutdown|Unable to shutdown.*Shutdown/i.test(err.message)) throw err
    }
}

async function erase(udid) {
    await run(['erase', udid])
}

async function screenshot(udid, outPath) {
    await run(['io', udid, 'screenshot', outPath])
    return outPath
}

/** Grant/revoke a privacy service for a bundle id (e.g. camera for Safari). Best-effort. */
async function setPrivacy(udid, service, bundleId, grant = true) {
    try {
        await run(['privacy', udid, grant ? 'grant' : 'revoke', service, bundleId])
        return true
    } catch (err) {
        // Not fatal — Safari camera is per-origin and the Simulator has no real camera.
        return { ok: false, reason: err.stderr || err.message }
    }
}

/** Open a URL in the device (launches Mobile Safari). Useful as a fallback path. */
async function openUrl(udid, url) {
    await run(['openurl', udid, url])
}

// ── Standalone app lifecycle (native mode) ──────────────────────────────────
// The Appium session installs+launches via `appium:app`; these mirror that for
// manual eyeballing (`ios-native run`) and best-effort teardown.

async function installApp(udid, appPath) {
    await run(['install', udid, appPath])
}

/** Launch an installed app by bundle id; returns its pid (as reported by simctl). */
async function launchApp(udid, bundleId, args = []) {
    const { stdout } = await run(['launch', udid, bundleId, ...args])
    return stdout.trim()
}

async function terminateApp(udid, bundleId) {
    try {
        await run(['terminate', udid, bundleId])
    } catch (err) {
        // Not running is fine.
        if (!/found nothing to terminate|Unable to terminate|No such process/i.test(err.message)) throw err
    }
}

async function uninstallApp(udid, bundleId) {
    try {
        await run(['uninstall', udid, bundleId])
    } catch (_) {
        /* not installed — fine */
    }
}

/** Spawn a video recording; returns a stop() that resolves when the file is finalized. */
function recordVideo(udid, outPath) {
    const child = execFile('xcrun', ['simctl', 'io', udid, 'recordVideo', '--codec=h264', '-f', outPath])
    return {
        outPath,
        async stop() {
            return new Promise((resolve) => {
                child.on('close', () => resolve(outPath))
                child.kill('SIGINT') // SIGINT finalizes the movie file
            })
        },
    }
}

module.exports = {
    DEVICE_NAME,
    run,
    ensureToolchain,
    listJson,
    resolveDevice,
    boot,
    shutdown,
    erase,
    screenshot,
    setPrivacy,
    openUrl,
    installApp,
    launchApp,
    terminateApp,
    uninstallApp,
    recordVideo,
    cmpVersion,
}
