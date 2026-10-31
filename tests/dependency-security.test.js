'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { fileURLToPath } = require('node:url')

function consumerRequire(name) {
    return createRequire(path.resolve(__dirname, '..', 'node_modules', name, 'package.json'))
}

test('Appium and WebDriver glob matchers bound adversarial pattern expansion', () => {
    for (const consumer of ['@appium/support', '@wdio/config', 'readdir-glob']) {
        const parent = consumerRequire(consumer)
        const matcher = consumer === 'readdir-glob'
            ? parent('minimatch')
            : createRequire(parent.resolve('glob'))('minimatch')
        const parsed = new matcher.Minimatch('a/**/../b/**/../c/**/../d/**/../e/**/../f', {
            optimizationLevel: 2,
            braceExpandMax: 4,
        })
        assert.ok(parsed.globParts.length <= 4, `${consumer} exceeded the expansion budget`)
    }
})

test('Appium and WebDriver discover nested specs and preserve exclusions', async t => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ios-dependency-globs-'))
    t.after(() => fsp.rm(root, { recursive: true, force: true }))
    await fsp.mkdir(path.join(root, 'nested'))
    await fsp.mkdir(path.join(root, 'ignored'))
    await fsp.writeFile(path.join(root, 'main.spec.js'), '')
    await fsp.writeFile(path.join(root, 'nested', 'child.spec.js'), '')
    await fsp.writeFile(path.join(root, 'ignored', 'skip.spec.js'), '')
    const appium = require('@appium/support')
    const matches = await appium.fs.glob('**/*.spec.js', { cwd: root, ignore: ['ignored/**'] })
    assert.deepEqual(matches.sort(), ['main.spec.js', 'nested/child.spec.js'])
    const { ConfigParser } = await import('@wdio/config/node')
    const config = new ConfigParser(path.join(root, 'wdio.conf.js'), {
        specs: ['**/*.spec.js'],
        exclude: ['ignored/**'],
    })
    assert.deepEqual(config.getSpecs().map(file => path.relative(root, fileURLToPath(file))).sort(), [
        'main.spec.js', 'nested/child.spec.js',
    ])
})

test('aborted Appium glob traversal stops filesystem reads', async t => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ios-aborted-glob-'))
    t.after(() => fsp.rm(root, { recursive: true, force: true }))
    for (const name of ['a', 'b', 'c']) {
        await fsp.mkdir(path.join(root, name, 'nested'), { recursive: true })
        await fsp.writeFile(path.join(root, name, 'nested', 'file.js'), '')
    }
    const controller = new AbortController()
    const reason = new Error('cancel traversal')
    let reads = 0
    const instrumented = {
        ...fs,
        readdir(dir, options, callback) {
            reads++
            fs.readdir(dir, options, (error, entries) => {
                if (reads === 1) controller.abort(reason)
                callback(error, entries)
            })
        },
    }
    const { glob } = consumerRequire('@appium/support')('glob')
    await assert.rejects(glob('**/*', { cwd: root, fs: instrumented, signal: controller.signal }), reason)
    const readsAtReject = reads
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(reads, readsAtReject, 'canceled traversal continued reading directories')
})
