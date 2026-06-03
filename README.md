# ios-harness

A test harness that runs **web apps in real iOS WebKit** (the iOS Simulator) and
verifies application functionality — the iOS-specific surface that desktop
browser test runners can't see. It pairs **`simctl`** (Simulator lifecycle) with
**Appium + the XCUITest driver** (driving Mobile Safari via WebdriverIO).

It is designed to be **additive** to a project's existing desktop browser tests,
not a replacement.

> Playwright (and other host browser runners) cannot target the iOS Simulator —
> their "WebKit" is a host build, not iOS. Appium + XCUITest is the standard way
> to drive real iOS WebKit, which is what this harness uses.

## What it catches

Things that pass on desktop WebKit but break on real iOS:

- WebGL / WebGL2 / WebGPU context not created, or **context loss**, on the iOS GPU stack
- shader / program compile failures surfaced via `console.error`
- uncaught JS errors / unhandled rejections during load + interaction
- **blank canvas** — nothing actually rendering
- **Web Audio stuck suspended** after a gesture (autoplay-policy regression)
- primary UI **clipped** by safe-area / dynamic toolbar on an iPhone viewport
- crashes / reloads under light interaction
- apps that gate rendering behind boot / project-picker / autoplay modals
- camera apps that must degrade gracefully where no camera exists (the Simulator)

## Quick start

Clone this repo **next to the product repos** it tests (they're discovered as
siblings by default; override with `NF_PLATFORM_ROOT`):

```
parent/
├── ios-harness/      ← this repo
├── noisedeck/
├── layers/
└── …
```

```bash
cd ios-harness
npm install
npm run bootstrap        # verify/auto-fix the toolchain (full Xcode, an iOS runtime, the Appium driver)
node bin/ios-test        # run all configured products
```

Common invocations:

```bash
node bin/ios-test noisedeck            # one product
node bin/ios-test noisedeck layers     # several
node bin/ios-test --smoke              # shared iOS-risk suite only (fast)
node bin/ios-test --list               # list product keys
npm run selftest                       # the harness's own unit tests (no Simulator)
```

Exit code is non-zero on any failure — suitable as a pre-commit gate.

## How it works

```
simctl (lib/simulator.js)   boots & owns a named iPhone Simulator
   │
   ├─ lib/server.js         serves each product's web root (or its own node server),
   │                        injecting an instrumentation shim (browser/trap.js) as the
   │                        first <script>, with HTTP Range support (iOS media)
   │
   └─ Appium + XCUITest      drives Mobile Safari attached to the booted device
      (lib/driver.js)        via WebdriverIO — DOM control + real native taps

   lib/runner.js             per product: serve → session → specs → artifacts
   specs/shared.js           iOS-risk suite, runs on every product
   specs/<key>.js            per-product deep functional flows
```

Products and how each is served/probed live in **`lib/products.js`**. Each entry
declares its web root, capabilities (webgl/audio/camera/…), orientation, any
load-time gates to dismiss, and whether it is backend-gated (served front-end-only
when its backend isn't run).

## Toolchain

Needs **full Xcode** (provides `simctl` + the Simulator), an **iOS runtime**,
Node ≥ 22, and the package-local **Appium** + **XCUITest** driver (installed into
a scoped `.appium/` by `npm run bootstrap`). Command Line Tools alone is **not**
enough. Accepting the Xcode license is a one-time `sudo xcodebuild -license accept`
(run it in a real terminal).

## Configuration

| Env | Effect |
|---|---|
| `NF_PLATFORM_ROOT` | parent dir holding the product repos (default: this repo's parent) |
| `NF_IOS_DEVICE` | pin device type, e.g. `iPhone 16` (default: newest plain iPhone) |
| `NF_IOS_RUNTIME` | pin runtime, e.g. `iOS 18.2` (default: newest available) |
| `NF_IOS_DEVICE_NAME` | name of the reused Simulator device (default `nf-ios-harness`) |

## Roadmap

The driver / `simctl` layers are built to extend from **Mobile Safari** to
**native iOS builds**: `simctl install` / `simctl launch` a built `.app`, then
drive its WebView through the same Appium XCUITest context. That enables testing
standalone (e.g. Capacitor / WKWebView) iOS builds alongside the web-in-Safari path.

## License

MIT — see [LICENSE](LICENSE).
