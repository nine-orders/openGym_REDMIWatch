// 模拟器/真机联调用的假 hub 常驻跑器：按 S3 契约实现（复用 test/fake-hub.mjs），
// 监听 0.0.0.0:8765，预置一份可开始的快照（ready.today），每次请求/事件落队都打印。
// 用法：node scripts/emu-hub.mjs [token]   （默认 token 73012598）
import { startFakeHub } from '../test/fake-hub.mjs'

const TOKEN = process.argv[2] || '73012598'
const NOW = Date.now()

const hub = await startFakeHub({ token: TOKEN, port: 8765, host: '0.0.0.0' })
hub.setSnapshot({
  v: 1, unit: 'kg', restSec: 90, active: null,
  ready: {
    today: {
      routineIds: ['r_emu'], name: '模拟器全家桶',
      // S6 手测全家桶：热身组、单侧组、超级组、有氧、计时各来一份；卧推带 best（记 40×10 触发 PR）
      entries: [
        { id: '0001', name: '卧推', mode: 'reps', restSec: 5, best: { w: 15, r: 8 }, sets: [
          { w: 20, r: 8, done: false, warmup: true },
          { w: 40, r: 10, done: false, warmup: false },
          { w: 40, r: 10, done: false, warmup: false },
          { w: 40, r: 10, done: false, warmup: false }
        ] },
        { id: '0002', name: '保加利亚分腿蹲', mode: 'reps', restSec: 5, perSide: true, sets: [
          { w: 20, r: 10, done: false, warmup: false, sides: { L: { w: 20, r: 10, done: false }, R: { w: 20, r: 10, done: false } } },
          { w: 20, r: 10, done: false, warmup: false, sides: { L: { w: 20, r: 10, done: false }, R: { w: 20, r: 10, done: false } } }
        ] },
        { id: '0003', name: '引体向上', mode: 'reps', restSec: 5, group: 'g1', sets: [
          { w: 0, r: 8, done: false, warmup: false }
        ] },
        { id: '0004', name: '划船', mode: 'reps', restSec: 5, group: 'g1', sets: [
          { w: 30, r: 12, done: false, warmup: false }
        ] },
        { id: '0005', name: '跳绳', mode: 'cardio', restSec: 5, sets: [
          { done: false, warmup: false }
        ] },
        { id: '0006', name: '平板支撑', mode: 'time', restSec: 5, sets: [
          { sec: 40, done: false, warmup: false }
        ] }
      ]
    },
    others: []
  }
})

console.log('[emu-hub] listening on 0.0.0.0:8765, token = ' + TOKEN + ', snapshot rev = ' + hub.state.rev)
setInterval(() => {
  console.log('[emu-hub] status: rev=' + hub.state.rev + ' queued=' + hub.state.queue.length + ' calls=' + hub.state.calls.length + ' acks=' + hub.state.ackLog.length)
}, 15000).unref()

// 每 800ms 把队列里的新事件摘要打出来；看到 start 就"确认开局"——把 ready.today 变成
// 带 wid 的 active 快照下发（手机端 applyEvents + sendSnapshot 的等价物），走通确认回路。
let seen = 0
let seenAcks = 0
setInterval(() => {
  if (hub.state.queue.length > seen) {
    for (const ev of hub.state.queue.slice(seen)) {
      console.log('[emu-hub] EVENT ' + JSON.stringify(ev))
    }
    seen = hub.state.queue.length
  }
  // 只加打印：把每次 POST /watch/events 返回的 acked id 批逐批打出来（ack 语义的落证）
  if (hub.state.ackLog.length > seenAcks) {
    for (const acked of hub.state.ackLog.slice(seenAcks)) {
      console.log('[emu-hub] ACK ' + JSON.stringify(acked))
    }
    seenAcks = hub.state.ackLog.length
  }
  const start = hub.state.queue.find(x => x && x.type === 'start')
  if (start && hub.state.snapshot && !hub.state.snapshot.active) {
    const base = hub.state.snapshot.ready && hub.state.snapshot.ready.today
    if (base) {
      hub.setSnapshot({
        v: 1, unit: 'kg', restSec: 90, ready: null,
        active: { id: start.wid, name: base.name, unit: 'kg', cur: 0, restSec: 90, start: NOW, entries: base.entries }
      })
      console.log('[emu-hub] confirmed start wid=' + start.wid + ' → snapshot rev=' + hub.state.rev)
    }
  }
}, 800).unref()
