// @vitest-environment happy-dom
// Run in the integrated OpenGym src/lib directory (see phone/README.md).
import { expect, it, vi } from 'vitest'
import { startWatchSync, _setWatchPluginForTest, _resetWatchSync } from './watch-sync.js'

function store(initial) {
  let state = initial
  const subscribers = new Set()
  return {
    getState: () => state,
    setState: patch => { const prev = state; state = { ...state, ...patch }; subscribers.forEach(fn => fn(state, prev)) },
    subscribe: fn => { subscribers.add(fn); return () => subscribers.delete(fn) }
  }
}

it('Android caches idle plans and phone-started workouts even when SDK reports watch app absent', async () => {
  vi.useFakeTimers()
  localStorage.clear()
  _resetWatchSync()
  let stop
  try {
    const bridge = {
      status: async () => ({ paired: true, installed: false, snapshotCache: true }),
      sendSnapshot: vi.fn(async () => ({ sent: true })),
      sendClips: async () => ({}), openOnWatch: async () => ({ ok: false }),
      drain: async () => ({ events: [] }), ack: async () => ({}),
      addListener: async () => ({ remove() {} })
    }
    _setWatchPluginForTest(bridge)
    const initial = { unit: 'kg', restSec: 90, workouts: [], week: {}, dayPlan: {},
      routines: [{ id: 'r1', name: '推日训练', ex: [{ id: '0025', sets: 3, reps: 8, weight: 60 }] }], active: null }
    const st = store({ S: initial, ready: true })
    stop = await startWatchSync({ useStore: st, useUI: store({ timer: null }) })
    await vi.runAllTimersAsync()
    expect(bridge.sendSnapshot).toHaveBeenCalledTimes(1)
    expect(JSON.parse(bridge.sendSnapshot.mock.calls[0][0].json).active).toBeNull()
    expect(JSON.parse(bridge.sendSnapshot.mock.calls[0][0].json).ready.others[0].name).toBe('推日训练')
    st.setState({ S: { ...initial, active: { id: 'mobile-w1', start: Date.now(), entries: [] } } })
    await vi.runAllTimersAsync()
    expect(JSON.parse(bridge.sendSnapshot.mock.calls.at(-1)[0].json).active.id).toBe('mobile-w1')
    st.setState({ S: initial })
    await vi.runAllTimersAsync()
    expect(JSON.parse(bridge.sendSnapshot.mock.calls.at(-1)[0].json).active).toBeNull()
  } finally { stop?.(); _resetWatchSync(); vi.useRealTimers() }
})
