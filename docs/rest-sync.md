# S9 休息同步与边界表（协议 v2.1）

日期：2026-11-12。设计参考：daoshi818-crypto/openGym fork 的 `watch-app/SYNC_PROTOCOL.md`
（其"phone authority / durable outbox / optimistic rest / 过期编辑保护"思路）与
`api/coach/core/chat.js`（子集安全、重放保护的取舍口径）。本 S3/S4 冻结契约之上的
**纯加法增量**：旧手机 × 新手表、新手表 × 旧手机都安全降级。

## 一、能力协商（ping.proto）

- `GET /watch/ping` 响应中的 `proto` 从 2 起支持休息事件，3 起支持扩容后的待同步队列。
- 手表 `hub.js protoPing()` 记住该数字；缺字段按 1（旧手机）。`phoneSupports(2)` 门控
  休息事件的**发送**（不发只是省队列——旧手机本来就会安全丢弃未知事件并照常 ack）。
- fork 的纪律沿用：协商标志逐项独立、单一标志不足以启用扩展；本增量只有一项（rest）。

## 二、休息事件（手表 → 手机）

事件形状（构造器在 `session-core.js`，形状对齐手机端 `applyEvents` 的读取）：

    { id, type: 'restAdjust', wid, at, add }   // +30 秒：add = 秒数（取整，>0 才产出）
    { id, type: 'restSkip',  wid, at }         // 跳过休息

- 页面（`session2.ux`）本地先动（乐观），再 `hub.js emitEvent()` 入队尽力上报；离线留队
  补投，与 start/finish 同款兜底。`lastRestEventAt` 记最后一次发出的事件时间。
- 语义不变式：休息事件**不改** SessionState（休息是页面本地的短时状态）；`at` 是事件时间，
  手机端过期即弃。

### 手机端应用（lib/watch-sync.js applyEvents + Workout.jsx 绑定）

- 新鲜度：`at` 距今超过 `REST_EVENT_MAX_AGE_MS`（60s）→ 丢弃但**照常 ack**（手表删队）。
- 屏幕没开：ack 并丢弃，**不排队、不打开训练页**——休息是短时状态，到的时候多半已过期
  （与 fork 的"过期编辑保护"同理；setDone 的排队/开门语义不受影响）。
- 屏幕开着：走 `handlers.restAdjust(add)` / `handlers.restSkip()`——即手机端自己的
  `useUI.addRest` / `stopRest`（同一套动作，绝不另写一份）。"计时器正在走"的守卫在
  Workout.jsx handler 里（useUI 在页面手里）：paused/ready/已到点的计时器不动。
- `addRest` 自带上限（REST_MAX）与"减到 0 = 跳过"语义，负秒数天然安全。

### 快照休息盖章（手机 → 手表）

`buildSnapshot` 的 `rest` 从 `{ endsAt }` 升级为 `{ endsAt, total?, at? }`：

- `total`：休息总秒数（useUI timer 自带），手表画进度条用。
- `at`：手机端休息状态最近一次变化的观察点（`startWatchSync` 订阅 timer 变化打点
  `restStamp`）。缺省（旧调用方 / 旧手机）不带 `at`，手表按"未盖章"保守处理。
- SNAPSHOT_VERSION 保持 1：全部是可选加字段，旧手表读新手机快照不受影响。

### 手表采纳守卫（session2.ux reconcile，乐观休息）

- 采纳条件：本端**没有未确认的休息事件**（`lastRestEventAt === 0`），或手机盖章
  `rest.at >= lastRestEventAt`；盖章缺失按不采纳。记录中（busy）不采纳。
- 休息页中：`rest.endsAt` 更晚才延长（`total` 取两值较大者画条）。
- 记组页中：手机端在休息而手表停着 → 跟手机进休息页（上游 Apple 版快照 rest 的本意）；
  总时长用 `total`，没有按当前动作 restSec 兜底。
- **只进/只延长，不从快照退出**：快照无 rest 也可能是手机屏幕没开而非"休息结束了"，
  两种情况分不清——退出永远由本端用户决定。跳过不做反向传播（本端按钮即真相）。

## 三、边界表（fork 参考的 bounds，按单用户场景收敛）

| 端 | 上限 | 策略 |
| --- | --- | --- |
| 手表事件队列（hub.js `QUEUE_MAX`） | 600 条 | 触顶先**压缩**；仍超限则拒绝入队。积压超过 200 条时，需手机 hub 报告 proto 3 或更高才会补传 |
| 压缩规则 | —— | 同 `(wid, exId, entryIdx, setIdx, side)` 的 setDone 只留 `at` 最晚一条（手机端 patchSet 本就 at 新者胜，丢旧无语义差）；start/finish/weighIn/healthDeleted/rest* **永不压缩** |
| 手机收件箱（WatchEventQueue.CAP） | 1200 条 | 满额时只确认收件箱已有或本次接收的事件；其余留在手表，等手机腾出空间后重试 |

fork 的"拒绝溢出优先于驱逐业务数据"在开炼的架构下要修正：开炼的事件是**唯一**业务拷贝
（手机落库全靠事件），宁可压缩（语义安全的去重）也不丢；压缩后仍超限才拒绝，且该场景
（单场训练 200+ 条互异事件）实际不可达。

## 四、兼容矩阵与测试口径

| 组合 | 行为 |
| --- | --- |
| 新手表 × 旧手机 APK | ping 无 proto → `phoneSupports(2)=false` → 休息事件不发，按钮纯本地（= v2.0 行为）；未知字段一律不解析 |
| 旧手表 rpk × 新手机 | 快照多出的 `total/at` 字段被旧 applySnapshot 忽略（零依赖克隆整读）；ping 多出的 proto 被旧 hub.js 忽略 |
| 新 × 新 | +30s/跳过 → 事件 → 手机计时器同动；手机端 +30 → 快照盖章 → 手表休息页延长 |

测试：`session-core.test.mjs` 37 项（+2 构造器）、`hub.test.mjs` 16 项（+4 边界/压缩/
emitEvent/协商）、`watch-sync.test.js` 28 项（+5 休息事件）、`WatchHubTest` 54 检查
（+1 proto）。watch 合计 141 项。真机验收项：手表 +30s → 手机通知/计时条同动；手机
+15s → 手表休息页延长；两端同时操作不回跳（乐观守卫）。
