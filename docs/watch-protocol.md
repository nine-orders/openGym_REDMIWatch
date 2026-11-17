# S4 手表协议切换 — 交接文档

日期：2026-11-01。目标（plan.md S4）：手表改说快照/事件协议——新增协议层（拉快照 →
存本地 → 驱动会话；记组/开局/结束 → 事件入本地队列 → POST → 收到 ack（按 id）才删队，
离线静默重试），api.js 基址改手机 IP，旧直连 PC 代码保留为 fallback。完成标准：
`watch-app/test/` 新增按 S3 契约实现的假 hub，模拟器完整跑通一轮训练且事件队列 ack 语义正确。

## 结论先行

- **完成标准全部达成**：7 个测试套件 115 项全绿（新增 `hub.test.mjs` 10 项对着真 TCP 的
  假 hub 跑一轮完整训练）；模拟器（redmi_watch 镜像）对着假 hub（`scripts/emu-hub.mjs`，
  S3 契约的 node 实现）完整跑通一轮训练——配对 → 开始训练（自动开局）→ 记 5 组 →
  总结 →「结束并同步」，hub 侧逐条收到 `start → setDone×5 → finish` 全部事件并 ack，
  总结页显示「已发到手机 ✓」，体量 1920 kg 与 40×10×3 + 30×12×2 精确一致。
- **架构落点**：新增 `src/js/hub.js`（协议层）与 `src/pages/session2/session2.ux`（v2 会话页）；
  v1（session.ux + 直连 PC 整档 PUT）原样保留为 fallback——index 未配对 hub 时照走 v1，
  S6 决定去留。配对页复用：host = 手机 IP（默认 :8765），配对码 = hub 的 8 位数字 token。
- **契约的两次补写**（实现时发现的必要决定，已回写本文与 plan.md，真 hub 侧无需改动）：
  1. **快照 rev 严格单调**：手表只认 `rev > lastRev` 的快照，更旧的一律当迟到包跳过。
     否则手机端结束训练后，一次迟到的旧快照会把会话复活（HTTP 拉取下手机只回最新快照，
     旧 rev 只会来自网络层的迟到，不该被应用）。手机重启后 rev 从 0 重爬，由
     `snapshot:null`（契约第 5 条）重置手表的 rev 记忆，极窄的撞值下一轮自愈。
  2. **手表事件队列必须串行化读改写**：记录/开局/结束各自 fire-and-forget 触发上报，
     入队与删队若不串行，迟到的旧 rest 会覆盖掉期间新入队的事件（PC JVM 测试外的
     node 测试里实测丢过）。`hub.js` 用一条串行链跑所有队列读改写，网络 POST 在链外，
     删队前重读现值、只减 acked 的 id、无变化不落盘。

## 手表侧语义决定（S6/S7 需要知道）

- **双 key 并存**：v2 用 `hubHost`/`hubToken`（手机 IP + 8 位数字 token），v1 的
  `host`/`token` 原样保留。index 以 `hubHost+hubToken` 是否齐全判定 hub 模式；配对成功
  才写 `hubToken`（ping 失败会清掉，避免误入 hub 模式）。
- **配对页（pair.ux）**：配对码页签键盘改为纯数字（hub token 是 8 位数字）；配对流程 =
  存 hubHost/hubToken → `GET /watch/ping` → `GET /watch/snapshot` 种子进本地状态
  （applySnapshot 到空白 SessionState）→ 成功后 1.2s 自动 `router.back()` 回主页。
  **v1 的 redeem 配对从页面退场**（`api.js` 的 redeem/getData 保留给已配对用户的
  fallback 链路与 e2e 测试）——已配对 v1 的手表装新 rpk 后存储仍在，可继续用 v1；
  新配对只能走 hub，直到 S6/S7 决定。
- **开局**：session2 onInit 拉快照——有 active 就接上（位置 = entryIndex + setIndex 的
  首个未完成组）；没有就自动开 `ready.today`；今天没安排但有 `ready.others` 就列出来
  挑（startOther）；都没有给可读错误。手表自开的会话发 `start` 事件（wid 手表生成），
  手机确认前 applySnapshot 不会让它被旧快照清掉（core 语义）。
- **记组**：`hub.recordSet(ei, si, {w,r,sec})` → core.tick → 状态落盘 + 事件入队 →
  尽力 flush。**单侧组无 L/R 按钮，按 sideUp 自动轮流**（第一下 L 第二下 R，两侧完成
  才算整组、才进下一处）；有氧组不带数值地记；计时组记秒。
- **轮询**：会话页训练/休息中每 10s 拉快照（S3 契约建议值），失败指数退避至 60s；
  每轮顺手 flush 事件队列。对账规则（S4 最小集）：手机端结束（快照无 active）→ 本地
  跟着进总结（endedOnPhone，用最后一眼 workout 出总结）；换了一场训练 → 重新接上；
  本端正在看的组被手机记掉 → 让位到下一个未完成组。手机端休息倒计时（snapshot
  `rest.endsAt`）**未接**——手表用自己的本地休息，S6 可加。
- **结束**：总结页「结束并同步」→ core.finish → finish 事件入队 → flush；队列清空才显示
  「已发到手机 ✓」，否则「未送达（稍后自动补投）」，再按一次就是重试。「丢弃本次」=
  本地 finish（清场 + finishedHere，旧快照不许复活）但**不发 finish 事件**——已记出去的
  组手机照收，手机端训练继续，由用户回手机上结束。
- **心跳**：v2 不发 /api/activity 心跳（训练在手机端跑着，管理面板「正在训练」来自
  手机自身）。

## 做了什么

1. **`src/js/hub.js`（新增）**：协议层。`ping` / `syncSnapshot`（rev 单调 + snapshot:null
   保状态）/ `enqueue` / `flush`（串行链 + 链外 POST + 删前重读）/ `recordSet` / `begin` /
   `end` / `abandon` / `loadState`/`saveState`。持久化键：`hubState`（SessionState JSON）、
   `hubQueue`（事件队列，最后一份拷贝）。rev 记忆为应用存活期模块变量（`forgetRev` 测试口）。
2. **`src/js/api.js`**：传输层抽成共用 `request()`；新增 `hubCall`（基址 `hubHost`，无端口
   补 `:8765`，Bearer `hubToken`）。v1 的 `call` 行为不变（e2e 全绿）。
3. **`src/pages/session2/session2.ux`（新增）**：v2 会话页。模板与样式沿用 v1（模拟器踩实
   的那套），状态驱动换成 session-core + hub。训练/休息/总结/others/错误五个 phase；
   1s 时钟 + 10s 快照轮询（退避 60s），onHide 全停。
4. **`src/pages/index/index.ux` / `pair.ux` / `manifest.json`**：hub 模式展示（手机 IP、
   待发事件数、今日来自快照 ready）与路由（开始训练 → session2，选动作单仅 v1 显示）；
   配对页改 hub 流程（见上）；manifest 注册 `pages/session2`。
5. **`test/fake-hub.mjs`（新增）**：S3 契约的 node 参照实现（401/400/404/405、/spike 免鉴权
   回声、按 id 去重入队、acked 语义、Connection: close）；`test/hub.test.mjs`（新增）：
   队列语义 3 项 + 真 TCP 集成 7 项（错 token 401、snapshot:null 保状态、开局 ack 删队 +
   重发无害、完整一轮含断网补投与 rev 去重、手机端结束 + 迟到旧 rev 跳过、畸形事件永不
   acked、单侧组 L→R）。
6. **`test/pages.test.mjs` / `lifecycle.test.mjs`**：登记 session2 页；lifecycle 新增
   index hub 模式 2 项 + session2 页面级 8 项 + pair hub 配对 4 项（含自动回主页）。
7. **`scripts/emu-hub.mjs`（新增）**：模拟器/联调假 hub 常驻跑器（0.0.0.0:8765，预置
   ready 快照，收到 start 自动「确认开局」下发 active——手机端 applyEvents+sendSnapshot
   的等价物），事件逐条打印。`scripts/emu-drive.mjs`：seq 模式改为每点拍一张（胶片排查）。

## 验证

| 事项 | 状态 | 证据 |
|------|------|------|
| 7 个测试套件全绿 | ✅ | session 15 / pages 6 / build-names 2 / e2e 6 / session-core 35 / hub 10 / lifecycle 41 = **115 项**（Windows 逐个跑） |
| 事件队列 ack 语义 | ✅ | hub.test：只删 acked、响应丢失保留、同 id 去重重发无害、畸形事件永不 acked、断网留队恢复补投 |
| 模拟器完整一轮训练 | ✅ | redmi_watch 镜像 + `scripts/emu-hub.mjs`：配对（10.0.2.2 + token）→ 开始训练 → 记 5 组（休息 5s 自动过渡）→ 总结「5 组 · 1920 kg」→ 结束并同步 →「已发到手机 ✓」 |
| hub 收到的事件账单 | ✅ | `start`（wid mvxz415s965591）→ hub 确认下发 active（rev=2）→ `setDone` 0001#0/#1/#2（40×10）+ 0002#0/#1（30×12）→ `finish`，全部 200 ack |
| 快照轮询与对账 | ✅ | 会话页每 10s GET /watch/snapshot（日志可见）；hub 确认后手表自动接上（dots/进度与手机一致） |
| 真机（手机 hub APK） | ⏳ 用户 | 同 S3 的实测步骤；手表侧已就绪，装新 rpk 后配对页填手机 IP + 通知栏 token |

## 过程中踩掉的坑（都进了 README「六点五」）

- **模拟器反复 `vapp` 重启会进坏状态**（`lv_nuttx_uv_fb_init fail : -22`）：渲染还在、
  点按全失效、存储读取也可能失败——曾把「配对成功却显示未配对」误判成存储丢失。
  解法：`adb -s emulator-5554 emu kill` 后重装（全新实例首启健康），全程单进程跑完。
- 模拟器里手表访问宿主用 **10.0.2.2**（QEMU 用户态网络网关 = 宿主回环），比局域网 IP
  稳；假 hub 绑 0.0.0.0:8765。
- cmd 的 `set "VAR=值"` 必须带引号，否则尾随空格进变量值。

## 遗留 / 下一步输入

- **S6（UI 集成）**：
  - 把 session2 的展示升级到 v2 语义的全部能力：跳过组长按（core.skip/isSkipped）、超级组
    轮转提示（core.next 的 rest）、单侧 L/R 双按钮（现在是自动轮流）、热身组展示、
    总结页 PR 口径展示（sumPrs 已算好）、手机端休息倒计时接入（snapshot active.rest）。
  - 决定旧直连代码去留：session.ux + session.js 的 v1 路径 + api.js 的 getData/putData/
    redeem + pick 页（v1 计划缓存）仍在；去掉则 index/pair 的双模式分支一并简化。
  - pair 页消息被键盘挤出屏幕底部（内容高度超 514），成功提示其实看不到——布局待调。
  - hub 开关与「Apple Watch」式的设置页（S3 遗留）。
- **S7（真机联调）**：手表真机 + 手机真机的实测仍待用户；README 的 v2 流程重写也在 S7。
- 已知 v0.1 简化（有意为之）：快照轮询只在会话页进行（index 打开时拉一次）；单侧组
  自动轮流不可回退一侧；训练中不接手机端 rest；watchStatus/setHr/healthDeleted 事件
  core 已支持但页面未用（红米表无 Health 写入，S6/S7 视需要接）。

## 改动文件（本窗口净增量）

- `watch-app/src/js/hub.js`（新增）、`src/js/api.js`（hubCall + request 抽取）
- `watch-app/src/pages/session2/session2.ux`（新增）、`src/pages/index/index.ux`、
  `src/pages/pair/pair.ux`、`src/manifest.json`
- `watch-app/test/fake-hub.mjs`、`test/hub.test.mjs`（新增）、`test/pages.test.mjs`、
  `test/lifecycle.test.mjs`
- `watch-app/scripts/emu-hub.mjs`（新增）、`scripts/emu-drive.mjs`（seq 逐点截图）
- `watch-app/README-手表应用.md`（目录/测试清单/坑 + v2 说明；同笔带上上一窗口
  模拟器实测的「六点五」文档）
- `docs/watch-v2/s4-watch-protocol.md`（本文）+ `docs/watch-v2/plan.md`（事实回写）

> 接力纪律照旧：commit 前先 `git status` 圈定自己的文件，别 `git add -A`。
> 本窗口另把上一窗口遗留的 Vela 坑修复（pick/session/spike 三页 + emu 脚本）单独
> 提交为 ecca581b，与本笔分开。
