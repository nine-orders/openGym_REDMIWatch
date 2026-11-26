import './register.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import IC from './stubs/interconnect.mjs'

const realInstance = IC.instance
const connected = ({ success }) => success({ status: 1 })
const channel = more => Object.assign({ send() {} }, more)

async function withProbe(name, instance, run) {
  IC.instance = instance
  globalThis.__icTimeout = 35
  try {
    const ic = await import('../src/js/ic.js?' + name)
    await run(ic)
  } finally {
    IC.instance = realInstance
    delete IC.default
    delete globalThis.__icTimeout
  }
}

test('missing connection factory keeps manual pairing available', () =>
  withProbe('missing-instance', undefined, async ic => {
    assert.equal((await ic.probeIc()).status, ic.IC_UNAVAILABLE)
    assert.equal(ic.icUp(), false)
    assert.throws(() => ic.icCall('GET', '/watch/ping'), /系统通道不可用/)
  }))

test('placeholder connection factory gives a clean unavailable result', () =>
  withProbe('placeholder', () => { throw new TypeError('not a function') }, async ic => {
    assert.equal((await ic.probeIc()).status, ic.IC_UNAVAILABLE)
  }))

test('state API can replace missing diagnosis on a connected channel', () =>
  withProbe('missing-diagnosis', () => channel({ getReadyState: connected }), async ic => {
    assert.equal((await ic.probeIc()).status, 0)
    assert.equal(ic.icUp(), true)
  }))

test('placeholder diagnosis falls back to connection state', () =>
  withProbe('throwing-diagnosis', () => channel({
    diagnosis() { throw new TypeError('not a function') }, getReadyState: connected
  }), async ic => assert.equal((await ic.probeIc()).status, 0)))

test('release wrapper and legacy APK status API can establish a candidate link', () =>
  withProbe('wrapped-legacy', undefined, async ic => {
    IC.default = { instance: () => channel({ getApkStatus: () => 1 }) }
    assert.equal((await ic.probeIc()).status, 0)
    assert.equal(ic.icUp(), true)
  }))

test('legacy APK status never treats a disconnected phone as connected', () =>
  withProbe('legacy-disconnected', () => channel({ getApkStatus: () => 2 }), async ic => {
    assert.equal((await ic.probeIc()).status, 1006)
    assert.equal(ic.icUp(), false)
  }))

test('state API does not claim a connection when disconnected or missing send', async () => {
  await withProbe('down', () => channel({
    getReadyState: ({ success }) => success({ status: 2 })
  }), async ic => assert.equal((await ic.probeIc()).status, 1006))
  await withProbe('missing-send', () => ({ getReadyState: connected }),
    async ic => assert.equal((await ic.probeIc()).status, ic.IC_UNAVAILABLE))
})

test('native diagnosis status and bounded timeout remain distinct', async () => {
  await withProbe('uninstalled', () => channel({
    diagnosis: ({ success }) => success({ status: 1001 }), getReadyState: connected
  }), async ic => assert.equal((await ic.probeIc()).status, 1001))
  await withProbe('timeout', () => channel({ diagnosis() {} }),
    async ic => assert.equal((await ic.probeIc()).status, 204))
})
