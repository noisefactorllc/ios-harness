'use strict'

/**
 * Product registry for the iOS Simulator test harness.
 *
 * One entry per shippable web app. The harness serves `webRoot` (or boots a
 * product's own node server), loads it in the iOS Simulator, and drives it.
 *
 * Fields:
 *   key            stable id (matches a specs/<key>.js if present)
 *   title          human name
 *   repoRel        path to the product repo, relative to the platform root
 *   webRoot        web root to serve, relative to repoRel (for static serve)
 *   serve          { type: 'static' } | { type: 'node', cmd, args, readyPath, env, portEnv }
 *   entry          path to open in Safari (default '/')
 *   orientation    'portrait' (default) | 'landscape' — set when the app forces it
 *   gates          selectors to tap-if-present after load (boot/autoplay/rotate overlays)
 *   ready          in-page predicate (fn body returning boolean) for interactivity
 *   primarySelector CSS selector for the primary UI surface (viewport-clipping check)
 *   capabilities   { webgl, audio, camera, midi, drag } — gates which shared probes run
 *   requiresCamera true when the core pipeline needs a camera the Simulator lacks;
 *                  shared render/webgl checks skip and a per-product camera-denied
 *                  spec asserts graceful degradation instead
 *   backendGated   true when core features need a backend that is not run here
 *   agentApi       name of an in-page test API exposed by the app, if any
 *   native         { appId, appName } — present when the product has a standalone
 *                  iOS build (Capacitor WKWebView wrapper in <repo>/mobile/). The
 *                  Capacitor webDir is derived from webRoot. Enables `--native`.
 *   notes          free text
 *
 * Capability/orientation/gate values below were mined from each product's source
 * and Playwright specs (see docs/superpowers/specs/2026-06-01-…-design.md).
 */

const path = require('node:path')

const PLATFORM_ROOT =
    process.env.NF_PLATFORM_ROOT ||
    // Default: this repo is cloned as a sibling of the product repos.
    // lib/ -> ios-harness -> <parent dir that holds the product repos>
    path.resolve(__dirname, '..', '..')

const READY_CANVAS = 'return document.readyState === "complete" && !!document.querySelector("canvas")'
const READY_DOC = 'return document.readyState === "complete"'

const PRODUCTS = [
    {
        key: 'noisedeck',
        title: 'Noisedeck',
        repoRel: 'noisedeck',
        webRoot: 'app',
        serve: { type: 'static' },
        primarySelector: 'canvas',
        ready: READY_CANVAS,
        capabilities: { webgl: true, audio: true, camera: false, midi: true, drag: true },
        native: { appId: 'app.noisedeck.ios', appName: 'Noisedeck' },
        notes: 'Flagship synth. 60 Playwright specs. #fileMenuTitle, [data-id=shuffle], #exportModal.',
    },
    {
        key: 'layers',
        title: 'Layers',
        repoRel: 'layers',
        webRoot: 'public',
        serve: { type: 'static' },
        // Layers onboarding is two modals: "New Project" base-layer picker (choose
        // Solid) -> "Canvas Size" picker (Create at default size). Both must be
        // dismissed for the renderer to initialize.
        gates: ['.media-option[data-type="solid"]', '#canvas-size-create'],
        primarySelector: '#canvas',
        ready: 'return document.readyState === "complete" && !!document.querySelector("#canvas")',
        capabilities: { webgl: true, audio: false, camera: false, midi: false, drag: true },
        agentApi: 'LayersAgent',
        native: { appId: 'app.layers.ios', appName: 'Layers' },
        notes: '79 Playwright specs. window.LayersAgent test API (addLayer/paintStroke/exportImage). Risks: file input, clipboard, large canvas.',
    },
    {
        key: 'polymorphic',
        title: 'Polymorphic',
        repoRel: 'polymorphic',
        webRoot: 'public',
        serve: { type: 'static' },
        primarySelector: '#canvas',
        ready: 'return document.readyState === "complete" && !!document.querySelector("#canvas")',
        capabilities: { webgl: true, audio: true, camera: false, midi: false, drag: true },
        native: { appId: 'app.polymorphic.ios', appName: 'Polymorphic' },
        notes: 'WebGL2/WebGPU. #code-toggle-btn, #dsl-editor, #programModal. Mic (getUserMedia) opt-in; MIDI guarded/no-op on iOS. viewport user-scalable=no.',
    },
    {
        key: 'shade',
        title: 'Shade',
        repoRel: 'shade',
        webRoot: 'public',
        serve: { type: 'static' },
        orientation: 'landscape',
        primarySelector: '#canvas',
        ready: 'return document.readyState === "complete" && !!document.querySelector("#canvas")',
        capabilities: { webgl: true, audio: false, camera: false, midi: false, drag: false },
        backendGated: true,
        native: { appId: 'app.shade.ios', appName: 'Shade' },
        notes: 'Shader editor; FORCES landscape (rotate overlay in portrait). #canvas-editor, #toggle-dsl-overlay, [data-param]. Its backend (/api/* chat/credits/export) is not run here — front-end only.',
    },
    {
        key: 'foundry',
        title: 'Foundry',
        repoRel: 'foundry',
        webRoot: 'public',
        serve: {
            type: 'node',
            cmd: 'node',
            args: ['server/index.js'],
            readyPath: '/health',
            portEnv: 'PORT',
            env: { NODE_ENV: 'test' },
        },
        orientation: 'landscape',
        primarySelector: '#canvas',
        ready: 'return document.readyState === "complete" && !!document.querySelector("#canvas")',
        capabilities: { webgl: true, audio: false, camera: false, midi: false, drag: false },
        native: { appId: 'app.foundry.ios', appName: 'Foundry' },
        notes: 'Runs real server for real CSP. FORCES landscape. Loads shader bundles from external hosts (needs network). #toggle-dsl-overlay, #menuLeft, [data-param]. Native build bundles public/ statically (no node server) — external shader CDNs still load over the network.',
    },
    // NOTE: "visualize" is intentionally NOT in this harness — it is a desktop-only
    // VJ tool (wide layout, MRT-heavy) and is covered by its own desktop Safari
    // (Playwright/WebKit) tests, not iOS.
    {
        key: 'photobox',
        title: 'Photobox',
        repoRel: 'photobox',
        webRoot: 'public',
        serve: { type: 'static' },
        primarySelector: '#stage',
        ready: READY_DOC,
        capabilities: { webgl: true, audio: false, camera: true, midi: false, drag: false },
        requiresCamera: true,
        benignErrors: ['camera', 'getUserMedia', 'NotAllowed', 'NotFound', 'NotReadable', 'permission denied'],
        native: { appId: 'app.photobox.ios', appName: 'Photobox' },
        notes: 'Camera app, NO file fallback — blocked without camera. On the Simulator (no camera) it shows a graceful "Camera access required" error in #stage. That graceful path IS the test. #shutter-btn, .mode-btn, .grid-tile.',
    },
    {
        key: 'glitcher',
        title: 'Glitcher',
        repoRel: 'labs/glitcher',
        webRoot: 'public',
        serve: { type: 'static' },
        primarySelector: '#stage-canvas',
        ready: 'return document.readyState === "complete" && !!document.querySelector("#stage-canvas")',
        capabilities: { webgl: true, audio: false, camera: true, midi: false, drag: true },
        requiresCamera: true,
        benignErrors: ['camera', 'getUserMedia', 'NotAllowed', 'NotFound', 'NotReadable', 'permission denied'],
        native: { appId: 'app.glitcher.ios', appName: 'Glitcher' },
        notes: 'Glitch-art (preserveDrawingBuffer). Camera-denied -> #error-banner; has #upload-btn file fallback. #glitchify-btn, #intensity, .preset-chip, swipe on canvas.',
    },
    {
        key: 'shuffleset',
        title: 'ShuffleSet',
        repoRel: 'shuffleset',
        webRoot: 'public',
        serve: { type: 'static' },
        gates: ['#autoplay-overlay button', '#autoplay-overlay'],
        primarySelector: '#transport-bar, #main, body',
        ready: READY_DOC,
        // Visualizer/playback require the streaming backend; front-end load only.
        capabilities: { webgl: false, audio: false, camera: false, midi: false, drag: false },
        backendGated: true,
        native: { appId: 'app.shuffleset.ios', appName: 'ShuffleSet' },
        notes: 'Heavily backend-coupled streaming player. Front-end renders + degrades gracefully when the stream backend is absent (404s). #btn-play-pause, #transport-seek, #autoplay-overlay gate.',
    },
]

for (const p of PRODUCTS) {
    p.repoPath = path.join(PLATFORM_ROOT, p.repoRel)
    p.webRootPath = path.join(p.repoPath, p.webRoot)
    if (!p.entry) p.entry = '/'
    if (!p.orientation) p.orientation = 'portrait'
    if (!p.gates) p.gates = []
    if (!p.ready) p.ready = READY_CANVAS
    if (!p.requiresCamera) p.requiresCamera = false
    if (!p.backendGated) p.backendGated = false
    if (!p.benignErrors) p.benignErrors = []
}

const BY_KEY = new Map(PRODUCTS.map((p) => [p.key, p]))

function allKeys() {
    return PRODUCTS.map((p) => p.key)
}

/** Products that have a standalone iOS build (Capacitor `mobile/` project). */
function nativeProducts() {
    return PRODUCTS.filter((p) => p.native)
}

function resolve(keys) {
    if (!keys || keys.length === 0) return PRODUCTS.slice()
    return keys.map((k) => {
        const p = BY_KEY.get(k)
        if (!p) throw new Error(`Unknown product "${k}". Known: ${allKeys().join(', ')}`)
        return p
    })
}

module.exports = { PRODUCTS, BY_KEY, PLATFORM_ROOT, allKeys, nativeProducts, resolve }
