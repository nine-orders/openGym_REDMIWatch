# S10 会话过期（协议 v2.1 补遗）

日期：2026-11-14。与 S9 同源的 fork 参考：其协议文档 "Unsaved watch sessions expire after
six hours from the current training segment's start. Previously saved history is retained.
The close event is queued for reconnection." 本篇把这条落到开炼的架构上。对 S3/S4 冻结契约
**零改动**（finish 事件是既有类型），纯手表侧行为 + 一个纯函数。

## 规则

- 锚点：`workout.start`（开局毫秒，手机确认的会话与手表自开的都适用）。超过
  `SESSION_EXPIRY_MS`（6 小时）即过期；无 start 无法判断就不判。
- 触发点：**仅会话页（session2）onInit**。页面开着（正在用）不查——训练中轮询、tick 都
  不过期，正在练的会话不会被打断；隔夜/久置的会话在下次打开时离场。
- 过期动作 = 复用 `finish()`：
  - wid 进 `finishedHere`（最近 5 场 tombstone）——手机还没处理 finish 时，旧快照不许把
    会话复活（S5 的 `gone` 语义，已存在，直接受益）；
  - `finish` 事件照常入队补投（**与手动 abandon 不同**：abandon 是用户在场、手机继续；
    过期是没人管，finish 让手机端自己收尾）。
  - 事件先持久化、再落状态（与 recordSet/begin/end 同序；中断自愈）。

## 手机端收到过期 finish 之后

走既有 `applyEvents` 的 finish 分支：训练页开着 → 手机端自己的结束落库流程（把已记的组
收进历史）；没开着 → 尝试 `openWorkout` 并等待绑定，下次 drain 应用。**已知行为**：手机
App 下次回到前台时会为这场过期训练打开训练页并结束落库——这是 fork 同款语义（数据完整
优先），6 小时阈值下"用户还在练"被误收尾的概率可忽略。

## 边界与不做什么

- 过期**不做反向传播**：手机端自己结束/丢弃训练的语义不变（快照 active:null → 手表跟
  随结束，S5 已有）。
- `finishedHere` 容量保持最近 5 场；过期 wid 挤掉最旧的旧 wid 是可接受的（旧快照存活
  时间远短于 5 场训练的间隔）。
- 不引入"训练分段"（fork 的 segment 概念来自其手表进程生命周期管理）；开炼的锚点就是
  开局时间，简单且足够。

## 测试口径

`session-core.test.mjs` 38 项（+1 isExpired：整点不判/超 1ms 判/无 start/无会话）、
`hub.test.mjs` 18 项（+2：过期离场 + finish 入队补投 + tombstone 拒绝复活；未过期/无
状态不动）。watch Node 合计 144 项。JVM 无改动（54 项不变）。真机验收项：手表开一场、
拨时间 7 小时、重进会话页 → 自动回主页流程（开始今日/就绪选择）、手机端收到 finish 落库。
