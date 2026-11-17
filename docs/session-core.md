# S5 SessionCore 移植 — 交接文档

日期：2026-11-01。目标（plan.md S5）：把 Apple Watch 版会话状态机逐条翻译成 JS，
手表 v2 与 Apple Watch 版语义完全对齐，语义冲突时一律以 Swift 为准。

## 做了什么

1. **基线确认**：动手前 5 个既有测试文件全绿（15 / 5 / 2 / 6 / 28 = 56 项）。
2. **移植 `session-core.js`**：`ios/App/WatchCore/Sources/WatchCore/SessionCore.swift`
   全部 17 个函数 + `Model.swift` 的派生标记，逐条翻译为零依赖纯 JS（见下方函数清单）。
   文件头注释块写清了核心类型字段约定（SessionState / Snapshot / ActiveWorkout / Entry /
   SetRow / BestSet / PendingTick / Event / WorkoutSummary），便于与 Swift 对照。
3. **翻写测试**：Swift 测试分布在 `Tests/WatchCoreTests/` 的三个文件、共 24 条用例
   （SessionCoreTests 9 + SetTypesTests 10 + SettingsAndWeighInTests 2 + HealthDeleteTests 3），
   逐条翻成 24 条 JS 用例，用例名带 Swift 原名，断言强度不变；另补 11 条「补充」用例
   覆盖 Swift 测试没碰到的分支。合计 35 项。
4. **验证**：6 个测试文件全绿（15 + 5 + 2 + 6 + 28 + 35 = 91 项，Windows 下逐个跑）。
5. **约束自查**：session-core.js 无任何 `import`（grep 确认）、无 `??` / `?.`（Vela 引擎
   保守语法）、无分号、风格对齐既有 `src/js` 文件。

### 导出函数清单（Swift → JS）

| Swift（SessionCore.swift） | JS | 返回形态 |
|---|---|---|
| `key(_:_:_:)` | `key(exId, si, side?)` | string |
| `applySnapshot(_:_:)` | `applySnapshot(state, snap)` | 新 state |
| `markSide(_:_:w:r:at:)` | `markSide(row, side, w, r, at)` | 新 row |
| `tick(_:entry:set:side:w:r:sec:at:id:hr:)` | `tick(state, ei, si, o)` | `[state, event]`，越界 `[原state, null]` |
| `skip(_:entry:set:)` | `skip(state, ei, si)` | 新 state，越界原样 |
| `isSkipped(_:_:_:)` | `isSkipped(state, exId, si)` | bool |
| `next(after:entry:set:)` | `next(state, ei, si)` | `{ entry, rest }`，越界 `{ entryIndex, false }` |
| `healthToDelete(gone:done:)` | `healthToDelete(gone, done)` | string[] |
| `healthDeleted(_:adding:)` | `healthDeleted(done, ids)` | string[]（留 300） |
| `healthDeletedEvent(_:id:)` | `healthDeletedEvent(ids, id)` | event 或 null |
| `weighIn(_:at:id:)` | `weighIn(w, at, id)` | event 或 null |
| `start(_:_:wid:at:id:bw:)` | `start(state, session, wid, at, id, bw?)` | `[state, event]` |
| `finish(_:at:id:)` | `finish(state, at, id)` | `[state, event]`，无训练 `[原state, null]` |
| `setIndex(_:entry:picked:)` | `setIndex(state, ei, picked?)` | number 或 null |
| `progress(_:)` | `progress(state)` | `{ done, total }`（排除热身组） |
| `summary(_:end:startedAt:endedOnPhone:)` | `summary(w, end, startedAt?, endedOnPhone?)` | WorkoutSummary 对象 |
| `beatsBest(_:_:_:)` | `beatsBest(entry, done, best)` | bool（更重 / 同重更多次 / 辅助反向 / 计时比秒） |
| —（SessionState() 默认构造） | `newState()` | 新 state（JS 侧补充） |
| —（Model.swift 计算属性） | `isTimed` / `isCardio` / `isBodyweight` / `sideUp` / `showFlags` | 小函数（JS 侧补充） |

## 改动文件

- `watch-app/src/js/session-core.js` — 新增；零依赖纯 JS，不碰 `@system.*` / store / names / api，
  不 import 任何 watch 模块（S3/S4 的 hub 语义、v2 复用都靠这一点）。
- `watch-app/test/session-core.test.mjs` — 新增；node:test + assert/strict，零桩
  （被测模块本身无平台依赖），中文用例名 + Swift 原名。
- `docs/watch-v2/s5-session-core.md` — 本文档。

不碰任何页面（接进 session.ux 是 S6 的事），不动 `src/js/session.js` 的 v1 路径
（todayRoutineId / DONE RULE 原样）。

## Swift→JS 用例对照表（24 条 1:1，未合并未删减）

| # | Swift 用例 | JS 用例（同一文件内按序） |
|---|---|---|
| 1 | testPicksUpAWorkoutRunningOnThePhoneWhenFirstOpened | 快照：第一次打开就接上手机正在跑的训练 |
| 2 | testATickStaysUntilTheSnapshotShowsItAndTheLaterTickWins | 记组留到快照确认，两边都改时晚的获胜 |
| 3 | testRelaunchRestoresTheSessionWithItsUnconfirmedTicks | 重启恢复会话，未确认的 tick 保住 |
| 4 | testFinishedOnTheWatchStaysFinishedThoughThePhoneHasNotHeard | 手表上结束就保持结束，哪怕手机还没听到 |
| 5 | testFinishedOnThePhoneEndsItHere | 手机上结束就让本端也结束 |
| 6 | testStartedOnTheWatchStaysUntilThePhoneHasIt | 手表上开的会话保持到手机确认 |
| 7 | testAnotherWorkoutOnThePhoneStartsClean | 手机换了一场训练就干净开局 |
| 8 | testProgressCountsWorkSetsOnly | 进度只数工作组 |
| 9 | testReadsASnapshotWithFieldsItDoesNotKnowAndWithoutOptionalOnes | 快照带未知字段、缺可选字段也能读 |
| 10 | testAHoldIsTickedWithItsSeconds | 计时组带秒数记 |
| 11 | testBodyweightCountsOnlyTheAddedWeight | 自重动作只算外加重量 |
| 12 | testAPerSideSetIsDoneOneSideAtATime | 单侧组一次只练一侧 |
| 13 | testWarmUpsAreNotWorkSets | 热身组不算工作组 |
| 14 | testASupersetGoesInTurnsAndRestsAfterTheRound | 超级组轮着做，一轮完了才休息 |
| 15 | testASkippedSetIsPassedOverNotDone | 跳过的组是被绕开不是被完成 |
| 16 | testCardioIsTickedWithoutNumbers | 有氧组不带数值地记 |
| 17 | testTheSummaryCountsTimeVolumeAndRecords | 总结：时长、体量与纪录 |
| 18 | testAnOlderPhoneWithoutTheNewFieldsStillReads | 旧手机缺新字段也能读，新字段也认得 |
| 19 | testAStateSavedByTheLastBuildStillLoads | 上个版本存的状态还能读 |
| 20 | testTheWeighInGoesOutAndRidesOnTheStart | 称重事件发出，且能搭在开局事件上 |
| 21 | testTheSettingsReadWithAndWithoutTheNewFields | 设置读新旧两种形态 |
| 22 | testOnlyWorkoutIdsNotDoneYetOnceEach | 只认训练 id、没撤过的、每条一次 |
| 23 | testDoneIsKeptBoundedAndANewRoundIsANoOp | 已撤列表有界，重复处理无事发生 |
| 24 | testASnapshotWithTheListReads | 快照带已删列表能读 |

补充用例（11 条，覆盖 Swift 测试未触及的分支）：tick 越界安全且不改入参 /
finish 无训练 + finishedHere 留 5 场 / weighIn 700 上界与负数 / next entry 越界 /
skip 越界 + 重复键去重 / setIndex picked 越界与已完成回落 / beatsBest 有氧与空 best 与
辅助同重比次数 / applySnapshot restSec≤0 与缺 unit 不覆盖 + entryIndex 夹取 /
单侧 pending 遇普通组丢弃 / summary startedAt 兜底与 endedOnPhone 透传 / markSide 纯函数性。

## 有意偏离及理由（语义均等价，无行为差异）

1. **返回形态**：Swift 元组 `(SessionState, Event?)` → JS 数组 `[state, event]`；
   `next` 的 `(entry:, rest:)` → `{ entry, rest }`。命名参数（entry:set:side:w:r:…）→
   `tick` 的第 4 参 opts 对象，键名与 Swift 参数一致。
2. **值语义**：Swift struct 赋值即拷贝；JS 用 `clone()`（JSON 往返）拷贝将被改动的
   workout/snapshot、浅拷贝 pending 后删键。状态数据全部来自 JSON 快照，此法无损；
   入参一律不被修改（有专门断言）。
3. **nil ↔ JS**：Swift 可选 nil / Codable 缺键 ↔ JS `undefined` / 缺键；pending 的
   `s.pending[k] = nil` ↔ `delete`。数值兜底用 `!= null ? v : 0` 三元（等价 `?? 0`，
   规避 Vela 不支持的 `??`）。
4. **JSON decode 类用例**（#9 / #18 / #19 / #21 / #24）：Swift 的 `JSONDecoder().decode`
   在 JS 对应 `JSON.parse`（JS 无 Codable 校验层）；「旧快照还能读」的容错责任在
   S4 的快照解析层，core 按文档的类型约定直读。断言逐条保留。
5. **舍入**：Swift `.rounded()`（toNearestOrAwayFromZero）对正数与 `Math.round` 等价；
   `weighIn` / `start` 的 guard 保证输入 `> 0`，故用 `Math.round`。
6. **补充的导出**：`newState()`（SessionState() 默认构造）、`isTimed` / `isCardio` /
   `isBodyweight` / `sideUp` / `showFlags`（Model.swift 的计算属性变函数）——core 函数与
   移植测试都依赖它们，S6 页面展示也会用（showFlags 是 WatchShow 默认值口径）。
7. **防御性小默认**：`applySnapshot` 末尾夹取 entryIndex 时对缺失值取 0（对应旧版本
   状态缺该键的形态），对正常状态无行为差异。

## 遗留

- 无阻塞项。`watch-sync.js`（手机端镜像逻辑：buildSnapshot / applyEvents / syncSideAggregate）
  属 S3 范围，本窗口未动。
- plan.md 提到的「dayPlan pin 细节未移植」在手机端 buildReady 侧处理，与 core 无关。

## 给 S6 的输入（UI 集成清单）

- `session.ux` 接入点，全部是现成导出：
  - 跳过组长按 → `skip` + `isSkipped` + `setIndex(state, ei, picked)`（点圆点找回）；
  - 超级组轮转提示 → `next(state, ei, si)` 的 `{ entry, rest }`（`rest` 即"一轮完了才休息"）；
  - 单侧 L/R 双按钮 → `tick(state, ei, si, { side: 'L' | 'R', ... })` +
    `sideUp(row)`（下一个该练哪侧）+ `sideUp === null` 时整组完成；
  - 热身组展示 → `row.warmup`；进度环 → `progress`（已排除热身）；
  - 总结页 → `summary(workout, end)` 的 `{ duration, sets, volume, prs, endedOnPhone }`，
    PR 判定已在 core 内（`beatsBest`）；
  - 事件上报 → `tick` / `start` / `finish` / `weighIn` / `healthDeletedEvent` 的第二个返回值，
    交 S4 的事件队列（按 `event.id` ack 后删队）。
- 快照接入：`applySnapshot(state, snap)`；落盘前用 `newState()` 初始化；状态可直接
  `JSON.stringify` 持久化（测试 #3 验证了无损往返）。
- 语义冲突时以 `session-core.js` 头注释与 SessionCore.swift 为准；本模块不许加任何
  平台依赖（保持零 import）。
