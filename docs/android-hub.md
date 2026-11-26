# S3 安卓 hub — 交接文档

日期：2026-11-01。目标（plan.md S3）：App 扮演 iPhone 角色——Capacitor `WatchBridge`
插件 + 前台服务 HTTP server + API 契约冻结。完成标准：APK 可构建安装；curl 拿到合法
快照；POST 一条 setDone 事件后训练界面看到该组完成。

2026-11-26 的本地 1.0.7 修复扩展了快照协议。`GET /watch/snapshot` 可返回可选字段 `epoch`，标识手机进程。手表在相同 `epoch` 内按 `rev` 判断新旧，在手机重启后可以接受新 `epoch` 下较低的 `rev`。旧手机省略此字段时沿用原有比较逻辑。系统通道、正式成品及最新验证结果见[手机同步修复记录](phone-sync-fix-20261126.md)。

## 结论先行

- **架构落锤实现**：`WatchBridge` 安卓插件（方法集与 iOS 逐一对应）+ `WatchHubService`
  前台服务承载 HTTP server（SpikeHub 验证过的 FGS + 双唤醒锁模式）。手表↔手机协议核心
  纯 Java、零依赖，随 APK 编译，同时在 PC JVM 上被 53 项测试逐条打穿（含真实套接字上
  的契约全表）——S4 照本文契约实现，两边对不上以本文 + `WatchHubTest` 为准。
- **本机能验证的全部验证掉**：协议核心 53 项 PASS；watch-app 全套 6 个 node 套件全绿；
  前端 watch-sync 相关 vitest 60 项全绿；APK gradle 构建通过（见下「验证」）。
- **留给用户实测**（无手机）：装 APK → curl 冒烟 → 训练页看到组完成（约 10 分钟，见文末）。
- 构建前置照 S2 预告补齐：platform-36 已装；gradle 首次拉取被 10s 超时卡死后改为
  **预播种** wrapper 缓存（见「构建管线」），后续窗口不再需要。

## 契约 v1（冻结，S4 照此实现）

传输：HTTP/1.1，一请求一连接，响应 `Connection: close`，Content-Type
`application/json; charset=utf-8`。端口 **8765**（与 S2 spike 同端口，S2 的两个 README
已注明换端口要三处同步改）。错误体恒为 `{"ok":false,"error":"<code>"}`。

鉴权：除 `GET /spike` 外全部要求 `Authorization: Bearer <token>`。token = 手机首启生成
的 8 位数字（SharedPreferences `watch_hub/token`），**显示在 hub 常驻通知栏**；不匹配 →
401；手机未设 token → 一律 401。

| 路由 | 方法 | 请求体 | 成功响应 | 错误码 |
|------|------|--------|----------|--------|
| `/spike` | GET/POST | 任意 | 200 `{"ok":true,"server":"hub","method","path","bodyLen","ua"}` | 免鉴权（S2 诊断页回声，不带数据） |
| `/watch/ping` | GET | — | 200 `{"ok":true,"server":"hub","rev":N,"time":ms}` | 401；非 GET 405 |
| `/watch/snapshot` | GET | — | 200 `{"ok":true,"rev":N,"snapshot":<对象\|null>}` | 401；非 GET 405 |
| `/watch/events` | POST | `{"events":[{...}]}` | 200 `{"ok":true,"acked":[<id>...]}` | 401；坏 JSON 400 `bad_json`；形状错 400 `bad_request` |
| `/watch/events` | GET | — | 200 `{"ok":true,"queued":[...]}`（调试：手机上尚未应用的事件） | 401 |
| 其余路径 | 任意 | — | — | 404 `not_found`；已知路径错方法 405 `method_not_allowed` |

**ack 语义（本契约的核心决定）**：

1. `acked` = **「手机已持久收到」**，不是「已应用」。POST 响应到达，手表即可删除这些
   id 的本地待发副本。应用是异步的：手机队列保存事件，直到页面 drain→applyEvents→
   saveNow→ack（lib/watch-sync.js 现有语义，未动）。
2. **重发无害**：手机按事件 `id` 去重（append-if-new）。POST 响应在路上丢了 → 手表重发
   同 id → 手机不重复入队，但 acked 照样返回该 id。
3. **畸形事件**：无字符串 `id` 的事件被跳过，永不 acked；其余同批事件照常。
4. **队列即最后一份拷贝**：手机侧队列落盘 `filesDir/watch-events.json`（写临时文件后
   原子改名），1200 条上限。队列满时只确认已收下的事件，剩余事件由手表重试。
5. **快照 null ≠ 会话结束**：进程刚重启、页面还没发过快照时 `snapshot:null`，rev 0。
   手表应保持本地状态/空闲，不得据此清会话。rev 每次 `sendSnapshot` +1，手表可比对
   rev 跳过重复解析。
6. **事件类型沿用 iOS 版**（`applyEvents` 已实现）：`start` / `setDone` / `finish` /
   `weighIn` / `setHr` / `watchStatus` / `healthDeleted`。v2 要新增类型须先补契约。
7. **轮询建议**（S4 定稿）：训练中 snapshot 每 10s，空闲 60s；失败指数退避；重发 =
   同 id 重 POST。
8. **插件通知**：hub 每收到一次成功 POST 事件，向页面发一次 `watchEvent` 插件通知
   （尽力而为）；WebView 冻结时通知丢失，页面唤醒（visibilitychange）后自会 drain。

与 iOS 的对应关系：`sendSnapshot` = 缓存快照供 GET；`drain`/`ack` = 手机队列的出入；
`addListener('watchEvent')` = 事件到达提示。`sendClips`/`dropClips` 空实现（红米表不收
GIF）、`openOnWatch` 恒 `{ok:false}`（HealthKit 专属），共享代码无需分支。

## 做了什么

### 1. 协议核心（`watch-app/hub/`，纯 Java，进 APK）

- `core/java/ch/duartesantos/opengym/watchhub/`：
  - `WatchJson.java` — 极简 JSON 解析/写出。整数 → Long；整值浮点写出不带小数点
    （1.7E12 这种 epoch 毫秒不会以 E 计数上线）；快照从不解析、原样内嵌（字节保真）。
  - `WatchHttp.java` — Vela 栈形状的请求解析（头 ≤16KB、体 ≤4MB）+ 响应头构造。
  - `WatchHub.java` — 路由 + Bearer 校验（`MessageDigest.isEqual` 恒时比较）+ 错误码。
  - `WatchEventQueue.java` — 事件队列：按 id 去重追加 / ack 删除 / 500 上限 /
    每次变更立即落盘；存储为可插拔接口（手机=文件，测试=内存）。
- `javatest/WatchHubTest.java` — PC JVM 53 项：JSON 往返/坏输入、队列去重/ack/上限/
  损坏恢复、请求解析、以及**真实套接字上的契约全表**（401/400/404/405、快照原样内嵌、
  重发去重、ack 语义、响应头逐字节）。`build.cmd` 一键跑，无需 SDK。

### 2. 安卓胶水（`src/frontend/android/app/src/main/java/ch/duartesantos/opengym/`）

- `WatchHubState.java` — 单例：token（首启 SecureRandom 8 位，存 SharedPreferences）、
  快照缓存 + rev、文件落盘的事件队列。服务与插件同进程，经此共享。
- `WatchHubService.java` — 前台服务（`specialUse`，Android 12+ 冻结风险靠 FGS 规避，
  同 RestTimerService 先例）：0.0.0.0:8765 accept 循环 + PARTIAL_WAKE_LOCK +
  WifiLock(FULL_HIGH_PERF)（S2 实测模式）；通知栏「openGym watch hub :8765 ·
  局域网IP · token」；POST 事件成功后主线程发插件通知。
- `WatchBridgePlugin.java` — `@CapacitorPlugin(name="WatchBridge")`，方法集见契约。

### 3. 对上游的四处小补丁（全部增量式）

- `MainActivity.java` — `registerPlugin(WatchBridgePlugin.class)` + onCreate 起 hub 服务
  （START_STICKY，进程被杀后拉回；开关 UI 留给 S6）。
- `AndroidManifest.xml` — `<service .WatchHubService specialUse>` 声明 + 子类型说明。
- `app/build.gradle` — `sourceSets` 加 `watch-app/hub/core/java`（APK 直接编译协议核心）。
- `src/lib/watch-sync.js` — 插件解析门控 `ios` → `ios|android`；文件头注释同步。

### 4. 构建管线（本机首次跑通 Capacitor 安卓构建）

- Android SDK（`<你的 SDK 目录>`）补装 `platforms;android-36`（sdkmanager，dl.google.com 直连快）。
- gradle 8.14.3 wrapper 的 10s networkTimeout 扛不住 services.gradle.org 的跳转链
  （→GitHub release 资产，本网络 connect 必超时；且 wrapper 对已存在 zip 仍会联网校验）。
  **解法（已固化）**：从腾讯镜像 `mirrors.cloud.tencent.com/gradle/gradle-8.14.3-all.zip`
  下载 224MB → 放进
  `%USERPROFILE%\.gradle\wrapper\dists\gradle-8.14.3-all\10utluxaxniiv4wxiphsi49nj\`
  （hash 目录名 = MD5(distURL) 的 base36）→ 解包 + 放 `gradle-8.14.3-all.ok` /
  `gradle-8.14.3-all.zip.ok` → 之后直接调用
  `…\gradle-8.14.3\bin\gradle.bat`（与 wrapper 同版本，等价）。后续窗口照用即可，
  不必再动 wrapper.properties。
- web 侧：`VITE_MOBILE=1` 在 Windows cmd 下的 npm script 会挂（Unix 语法），分步执行：
  `set VITE_MOBILE=1&& npx vite build` → `node ../scripts/catalogue/stage-media.mjs dist`
  → `npx cap sync android` → `node scripts/check-mobile-bundle.mjs`。
- AGP 8.13.0 + androidx 依赖走 `google()`（=dl.google.com，直连 0.2s）+ maven central
  （直连可达），无需代理；maven.google.com 不通不影响（gradle 不用它）。AGP 顺手自动
  装了 build-tools 35.0.0 与 platform-tools 37（license 已预写，dl.google.com 直连）。
- `android/local.properties` 新建（`sdk.dir=<你的 SDK 目录>`；本就被 .gitignore；
  只设 `ANDROID_HOME` 而不写 local.properties 会被 AGP 忽略——AGP 优先读 local.properties）。
- 已知怪癖：gradle 首启偶发 `FileLockContentionHandler ... Address already in use`
  （UDP 临时端口 bind 竞态，机器上无排除段、端点也少，重试即过）——重跑即可。

## 验证

| 事项 | 状态 | 证据 |
|------|------|------|
| 协议核心（JSON/队列/路由/鉴权/错误码/ack） | ✅ | `watch-app\hub\build.cmd` → WatchHubTest **53 项 PASS**（含真实套接字契约全表） |
| watch-app 基线 | ✅ | session / pages / build-names / e2e / lifecycle / session-core 六套件全绿 |
| 前端 watch-sync 门控放开 Android | ✅ | vitest watch-sync 相关 5 文件 60 项全绿（iOS 语义零改动） |
| web 构建进 APK | ✅ | vite build 2.16s + stage-media（6554 静图/动图）+ cap sync + check-mobile-bundle OK |
| APK 构建 | ✅ | `gradle :app:assembleSideloadDebug` 通过 →
  `src\frontend\android\app\build\outputs\apk\sideload\debug\app-sideload-debug.apk`（227 MB，
  debug 全量含动图资产）；aapt2 badging：applicationId `ch.duartesantos.opengym.test`
  （与正式版并存）、compileSdk 36、label `OpenGymTest`；manifest 含 WatchHubService
  specialUse 声明；解 dex 验证 WatchHubService/WatchBridgePlugin/WatchHubState +
  watchhub 四类全部在列。首次全量 17m44s（大头是拉 AGP/androidx），增量重编约 3 分钟。 |
| curl 冒烟（真机） | ⏳ 用户 | 手机装 APK → 通知栏读 IP+token → curl 三个路由（文末步骤） |
| POST setDone → 训练页可见 | ⏳ 用户 | 手机开一局训练 → PC curl POST setDone → 手机训练页该组打勾（同一 store，即「网页端」所见） |

> 注：S2 已实证本机无法跑安卓手机模拟器（emulator-5554 是 AIoT 手表模拟器），手机侧
> 的 curl 冒烟只能真机；PC JVM 套接字测试是它在构建机上的等价物（同一份 handle() 代码
> 在 127.0.0.1:18766 上被 HttpURLConnection 全表打过）。

## 实测步骤（约 10 分钟）

1. 安装 `src\frontend\android\app\build\outputs\apk\sideload\debug\app-sideload-debug.apk`
   （applicationId 带 `.test` 后缀，与正式版并存）。打开 app，允许通知 → 常驻通知
   「openGym watch hub :8765」显示 IP 与 token。
2. PC 上（同一 WiFi）：`curl -H "Authorization: Bearer <通知栏token>" http://<手机IP>:8765/watch/ping`
   → `{"ok":true,...}`；`curl … /watch/snapshot` → `{"ok":true,"rev":N,"snapshot":…}`。
3. 手机 app 里开一局训练（页面会自动开始推快照，rev 递增），再 curl snapshot 确认 active
   有内容。
4. `curl -X POST -H "Authorization: Bearer <token>" -d "{\"events\":[{\"id\":\"pc1\",\"type\":\"setDone\",\"wid\":\"<active.id>\",\"exId\":\"<动作id>\",\"entryIdx\":0,\"setIdx\":0,\"w\":40,\"r\":10,\"at\":<ms>}]}" http://<手机IP>:8765/watch/events`
   → 响应 `{"ok":true,"acked":["pc1"]}` → 手机训练页第一组变已完成、休息计时启动。
5. 息屏复测（S2 已验过的场景在真 hub 上复走一遍）：手机锁屏 30s/2min 后重复第 4 步。

## 遗留 / 下一步输入

- **S4（手表协议切换）**：api.js 换手机 IP；新增协议层照本文契约；假 hub 用 node 桩
  （按契约即可，`WatchHubTest` 是参照实现）；事件队列 + ack 语义照 §「ack 语义」。
- **S6（UI 集成）**：hub 开关（现在恒开——FGS+锁的电池成本 v0.1 已知，见下）、Android 版
  「Apple Watch」设置页（显示 IP/token/状态）、配对页 host 语义 = 手机 IP。
- **已知 v0.1 简化**（有意为之，均记录在案）：
  - hub 恒开（app 打开即启、START_STICKY），无双唤醒锁的电池代价由用户实测评估；
  - `status()` 的 paired/installed 恒 true（红米表无法探测装机），`reachable`=服务在跑；
  - token 只在通知栏可见（无应用内显示页）；通知默认锁屏可见，重装不清 token，
    换手机清空（SharedPreferences 随 app 数据）。
  - 快照缓存纯内存：app 进程死后到页面首次 sendSnapshot 前，GET 拿到 `snapshot:null`
    （契约第 5 条已定义手表行为）。
- **build:mobile 的 npm script** 在 Windows 下跑不通（`VITE_MOBILE=1` 前缀），本窗口以
  分步命令执行；是否给 scripts 加 cross-env / 拆 Windows 变体，留给后续窗口决定。
- watch-app 的 `spike/phone-server/`（SpikeHub）使命完成：真机上装了 hub APK 后无需
  再装 SpikeHub（同端口 8765 冲突）；spike 页保留作传输诊断（`/spike` 路由已保留兼容）。

## 改动文件（本窗口净增量）

- `watch-app/hub/`（新增）— core 4 类 + javatest + build.cmd + README.md + .gitignore
- `src/frontend/android/app/src/main/java/ch/duartesantos/opengym/`（新增 3 文件）—
  WatchHubState / WatchHubService / WatchBridgePlugin
- `src/frontend/android/app/src/main/java/ch/duartesantos/opengym/MainActivity.java` —
  注册插件 + 起服务（小补丁）
- `src/frontend/android/app/src/main/AndroidManifest.xml` — service 声明（小补丁）
- `src/frontend/android/app/build.gradle` — sourceSets（小补丁）
- `src/frontend/src/lib/watch-sync.js` — 门控放开 Android（小补丁）
- `src/frontend/android/local.properties`（新增，gitignore 内）
- `docs/watch-v2/s3-android-hub.md`（本文）+ `docs/watch-v2/plan.md`（把契约定稿标记回写，
  若有）

> 接力纪律照旧：commit 前先 `git status` 圈定自己的文件，别 `git add -A`（S2 教训）。
