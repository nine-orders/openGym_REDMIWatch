# 手机 ↔ 红米手表同步故障排查与修复（2026-11-26）

## 最新修复 1.0.8

1.0.7 真机复测发现手机端误判小米 SDK 的 `DEVICE_MANAGER` 授权，导致消息监听未注册。1.0.8 已改用权限名称判断，两端正式成品已构建并核验。1.0.8 手机与现有 1.0.7 手表的自动配对、快照读取和事件上报已通过真机复测。更新手表到 1.0.8 后可看到更准确的连接状态文案。见[真机复测与修复细节](#107-真机复测与-108-修复)。

| 安装文件 | 显示版本 / 内部版本号 |
|---|---|
| [1.0.8 手机 APK](../watch-app/dist/phone-sync-fix-1.0.8/android/openGym-watchhub-LTNS-1.0.8.apk) | 1.4.3 / 30 |
| [1.0.8 手表 RPK](../watch-app/dist/phone-sync-fix-1.0.8/openGym-RedmiWatch5-LTNS-1.0.8.rpk) | 1.0.8 / 9 |

## 1.0.7 初次打包记录

1.0.7 手机同步修复已合入本地源码，并打包为两份配套的正式签名安装包。自动化回归、完整构建和成品核验已通过。初次打包时无已连接设备，随后取得真机结果并继续修复至 1.0.8。

| 安装文件 | 设备显示版本 / 内部版本号 | 大小 |
|---|---|---:|
| [手机 APK](../watch-app/dist/phone-sync-fix-1.0.7/android/openGym-watchhub-LTNS-1.0.7.apk) | 1.4.3 / 29 | 223,731,427 B |
| [手表 RPK](../watch-app/dist/phone-sync-fix-1.0.7/openGym-RedmiWatch5-LTNS-1.0.7.rpk) | 1.0.7 / 8 | 68,705 B |

两端包名均为 `ch.duartesantos.opengym`，沿用旧正式包的签名证书，SHA-256 指纹为 `dd3e02e3821127553a44761800552ac9baab2a4875f35a1f5437134b8195fbd2`。先更新手机 APK，再通过 AstroBox 更新手表 RPK。设备上的旧包如果包名和签名相同、内部版本号更低，可以覆盖升级并保留应用数据。成品位于本机 `watch-app/dist/phone-sync-fix-1.0.7/`，旧包已归入 `watch-app/dist/archive/`。见[安装说明](../watch-app/dist/phone-sync-fix-1.0.7/README.md)、[文件校验值](../watch-app/dist/phone-sync-fix-1.0.7/SHA256SUMS.txt)和[历史版本索引](release-archive.md)。

## 故障定位与源码修复

电脑直连使用 `/api/*`，手机手动配对使用 HTTP `:8765/watch/*`，手机自动配对使用小米 `system.interconnect`，由 `WatchInterconnect` 转交同一组 `/watch/*` 路由。

### 正式包核对

用户确认使用的手表包是 `watch-app/dist/archive/weight-display-test-1.0.6/openGym-RedmiWatch5-LTNS-1.0.6.rpk`，内部版本号为 7。初次排查误选了本机 `.test` Debug APK 和仓库旧 RPK。那组文件的包名差异不能用于判断此次故障。

实际使用的 1.0.6 RPK 与仓库配套正式手机包 `watch-app/dist/archive/astrobox-release-1.0.0/android/openGym-watchhub-LTNS-1.0.0.apk` 的包名及证书一致。旧正式 APK 的字节码确实读取 `WatchHttp.Response.text`，会将 `OK` 等 HTTP 状态文字作为响应数据发送。如果手机安装的就是这份正式 APK，配对包名和签名匹配，且该 APK 存在已证实的回包缺陷。手机上实际安装的 APK 文件仍待真机确认。

### 修复内容

1. 手机 `WatchInterconnect.handle()` 原先回复 `res.text`，但 `WatchHttp.Response.text` 是 HTTP reason phrase（例如 `OK`），JSON 实际在 `res.body`。系统通道因此收到形如 `{id,status:200,body:"OK"}` 的应答，无法得到 ping、动作单、训练或事件 ack；HTTP 则写入了正确的 `res.body`。PC JVM 对实际桥接类的回包复现了错误。修为 UTF-8 响应体，手表明确拒绝错误的非 JSON 成功应答，错误响应保留业务错误码。
2. 手机监听绑定依赖首次节点变化及 `isWearAppInstalled()` 成功；授权/监听失败、晚连接、同一节点重新连接后不能可靠恢复。现在独立查询安装状态，10 秒刷新节点、失败重试、断开重置监听，服务销毁时取消监听；`watchState` 通知前端重新查询状态。
3. 手机前端原本用 `paired && installed` 判断要否发布快照。该状态是小米 SDK 的安装检测，不代表手机本地 HTTP hub 能否缓存数据。新增原生状态 `snapshotCache: true`，Android 无需等待检测确认就可在档案加载、计划与进行中训练变化时缓存快照；iOS 原有判断不改。
4. 旧诊断页把电脑裸 IP 当作手机 IP，再尝试 `:8765`，且只使用 HTTP。新版默认使用手机保存的连接，自动配对时 GET/POST 直接测试系统通道；未配对可点「系统」先测；手动指定 IP 可测 HTTP；「对照PC」只测电脑。手机 HTTP 业务请求增加 10 秒超时，失败保留队列。
5. 手表停留在首页时，每 10 秒刷新一次已设置的手机连接，刷新失败后等待 20 秒重试并保留已有缓存，离开页面后停止轮询。快照增加可选字段 `epoch`，用于区分手机重启前后的 `rev`。快照按顺序应用，避免首页和训练页的旧响应覆盖新状态。

## 测试与成品核验

仓库根目录执行：

```powershell
node --test watch-app/test/*.test.mjs
watch-app\hub\build.cmd
powershell -NoProfile -ExecutionPolicy Bypass -File phone/test/run-bridge-test.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File phone/test/run-frontend-test.ps1 -OpenGym 'F:\AI\1_Projects\OpenGym'
```

验证覆盖：电脑直连配对、动作单、整场离线补投；手机 HTTP 有界失败与事件重试；系统通道 JSON GET/POST、UTF-8 动作单、错误回应、断线/授权/监听失败恢复、去重 ack；手机档案/训练状态发布；首页主动刷新、进程重启及旧快照保护。

源码回归全部通过。手表 Node 163/163、Java HTTP 与队列契约 57/57、手机桥接 15/15、手机前端状态订阅 1/1。手表静态与生命周期测试已分开写入生成模块，全量并行执行通过。正式打包时，配套手机工程额外通过 92 项同步、训练页和设置页专项测试。

- 手机侧通过 Android SDK、小米 `xms-wearable-lib_1.4_release.aar` 和 Capacitor 编译，完成 Vite 移动端构建、Capacitor 同步和 Gradle `assembleSideloadRelease --offline`。成品通过 APK v2/v3 验签及 16 KB 对齐检查。字节码确认桥接读取 `Response.body`，并包含 `snapshotCache`、`systemReady` 和快照 `epoch`。包内 WebView 前端包含快照订阅修复。
- 手表侧完成 Vela 正式构建。成品通过 ZIP CRC 校验，两份 manifest 的包名和版本一致，签名证书与原正式包一致。编译内容包含系统通道诊断入口和首页轮询。
- 复核两份成品的 SHA-256 均与交付校验值一致。见[成品校验值](../watch-app/dist/phone-sync-fix-1.0.7/SHA256SUMS.txt)。

## 源码集成与打包记录

本仓库保存手表源码、手机集成代码及协议核心。正式 APK 使用配套完整 Android 工程 `F:\AI\1_Projects\OpenGym` 构建。已核对 MainActivity 的 WatchBridge 注册与服务启动、Manifest 声明，以及 App.jsx 的 `startWatchSync` 接线。打包时临时接入四个 Java 类和协议核心，手机前端仅合入 `checkLink()` 的 `snapshotCache === true` 条件，保留完整工程原有的计划浏览功能。移动资源输出到 `dist-mobile`。打包后，配套工程的追踪文件已恢复，Git 工作区已核对为干净。见[安卓集成说明](../phone/README.md)。

RPK 在独立打包目录构建，内部版本号从 7 升至 8。APK 保持上游显示版本 1.4.3，内部版本号从 28 升至 29。签名使用原正式证书，密钥材料留在受保护的本机位置。复现调试配对时，Debug APK 的 `.test` 包名应与对应 RPK 的包名一致，并使用同一调试证书。见[手表打包说明](../watch-app/README.md#七打包)。

## 真机验收（按顺序）

| 步骤 | 操作 | 通过标准 |
|---|---|---|
| 安装 | 先覆盖升级手机 APK，再通过 AstroBox 更新手表 RPK。 | 手机档案保留，手表显示 1.0.7，已有手表数据可读取。 |
| 1 | 手机打开配套 openGym，确认登录档案及至少一个动作单；小米运动健康显示手表已连接。 | 手机 hub 常驻通知出现，手机有正确的 Wi-Fi IP 与配对码。 |
| 2 | 手表进入「配对设置 → 传输诊断 → 系统」，点 GET 和 POST。 | 两条都显示「系统 … ✓」，手机日志记录收到 `/spike` 和回复发出。 |
| 3 | 选择手机自动配对，回首页点击「选动作单」。 | 手机响应 ping，手表读取并保存快照，列表与手机现有动作单一致。 |
| 4 | 手表停留首页，手机开始训练，再完成一组并结束训练。 | 首页约一个成功轮询（10 秒）内出现「当前训练/继续训练」。手表进入会话后显示已完成组，手机结束后手表收起进行中状态。 |
| 5 | 手表开练并记一组，暂断连接再恢复。分别复测锁屏、手机进程重启和小米服务重连。 | 断网期间本地待同步增加，恢复后按 id 确认补投，同组只入账一次。重启后较低 `rev` 的新快照仍有效。 |
| 6 | 测试手机 HTTP 时，在诊断页输入手机 Wi-Fi IP，检查 GET 和 POST，再用手机 hub 通知里的码手动配对。同一 Wi-Fi 的电脑也可分别访问 `/spike`、带 token 的 `/watch/ping` 和 `/watch/snapshot`。 | 可达时手动配对能读取训练，电脑可看到快照的 `ready.today` 或 `ready.others`。`snapshot:null` 表示手机尚未缓存快照。HTTP 超时后本地缓存仍可用。 |
| 7 | 切换电脑已保存连接，离线完成训练并恢复电脑网络。 | 电脑动作单仍可用，离线训练按原有逻辑补传，训练历史无重复。 |

手机日志（不需要分享配对码或快照内容）：

```powershell
adb logcat -v time -s WatchInterconnect WatchHub
```

重点观察 `message listener ready`、`request GET /watch/ping`、`response ... status=200 bytes=...`、`reply sent`、`snapshot cached rev=...`。如有 `DEVICE_MANAGER refused`、`listener add failed`、`reply send failed`，记录发生在哪一环。若电脑访问手机 `/spike` 成功但手表 HTTP 失败，重点核查小米运动健康代理能否转发到手机本机地址；若系统诊断成功但手表业务仍失败，重点核对手机快照内容、回复大小及手表端解析。真机上不要把 HTTP 和系统通道的超时混为一谈。

待真机验证的场景包括红米 Watch 5 与 HyperOS 的系统通道、蓝牙代理到手机的可达性、大动作单的消息大小上限、息屏与进程重启后的恢复，以及手表实际离线 15 天的存储与补传。

## 1.0.7 真机复测与 1.0.8 修复

用户在红米 Watch 5 上复测时，电脑直连正常。手表的系统通道 GET 和 POST 都显示应答超时，自动配对能进入等待 openGym 回应，但无法继续。配对页显示的「已配对手机」来自本地已保存的连接，点「重试自动连接」才会重新向手机发起请求。

USB 调试确认手机安装的 APK 与 1.0.7 成品 SHA-256 一致。手机上的 openGym 已绑定小米运动健康穿戴服务，手机 HTTP `/spike` 返回 200。系统通道日志则反复记录 `DEVICE_MANAGER not granted`，消息监听没有完成注册。

1.0.7 的授权判断使用 `Permission` 对象相等性。小米 SDK 的 `Permission.CREATOR` 会从 Binder 重新创建对象，该类沿用对象身份比较，导致回调中的同名授权被误判。1.0.8 改为比较权限名称，并用重建对象的 SDK 桩复现、回归。手机桥接 16 项与手表 Node 163 项通过。手表保存页改为「已保存手机连接」，使用已保存的系统配置时提供「重试自动连接」。

1.0.8 APK 已在用户确认后通过 USB 覆盖安装，手机实际文件 SHA-256 与交付成品一致。新进程日志显示 `node wearAppInstalled=true`、`message listener ready`，随后缓存了训练快照。18:59 起，手机实际收到并成功回复系统通道的 `/watch/ping`、`/watch/snapshot` 和 `/watch/events`，均为 200。用户确认自动连接恢复。本轮用现有 1.0.7 手表端验证通信，1.0.8 RPK 的显示文案已在成品中核对，真机显示及锁屏重连待后续验证。见[1.0.8 文件校验值](../watch-app/dist/phone-sync-fix-1.0.8/SHA256SUMS.txt)。
