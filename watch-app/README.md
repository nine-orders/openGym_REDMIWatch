# 开炼 —— 红米 Watch 5 安装、配对与使用

手表上记每组（重量×次数）、看下一组练什么、组间休息倒计时；热量/心率/时间由手表
**自带的运动模式**统计。首次配对默认选择电脑直连，手表可缓存动作单并离线记录。
使用手机中转时，主动点首页「同步手机」跟记手机发起的训练，手表把记组和结束事件发给手机。

```
红米 Watch 5 (快应用)            安卓 openGym App (Capacitor)
  GET  /watch/snapshot ─────▶  读取动作单和进行中的训练
  POST /watch/events   ─────▶  接收训练事件，按 id 回传 acked
```

- 手机中转支持**小米系统通道自动配对**和**手机 HTTP 手动配对**。训练事件得到手机确认后，手表移除相应的待发事件。
- 手机中转模式下，组数与体量口径、PR、跳过、单侧 L/R、热身/超级组标签均与 Apple Watch 版对齐
  （session-core 状态机逐条移植，见 [docs/session-core.md](../docs/session-core.md)）。

手机端（安卓 openGym App）的 hub 集成见 [phone/README.md](../phone/README.md)；
协议文档见仓库根 [`docs/`](../docs/)。

当前手表版本为 1.0.10，修复 V4 首页的动作单列表滑动。配套安卓 App 使用 1.0.8。[正式签名 RPK](https://raw.githubusercontent.com/nine-orders/openGym_REDMIWatch/astrobox-release-1.0.10/astrobox/openGym-RedmiWatch5-LTNS-1.0.10.rpk) · [首页实施记录](../docs/watch-home-v4-20261126.md) · [手机同步修复记录](../docs/phone-sync-fix-20261126.md)

## 一、前置条件（一次性）

1. **使用手机中转时，在安卓手机上安装 openGym App**（集成 watch hub 的 APK，构建方法见
   [phone/README.md](../phone/README.md)）并登录你的档案（手机端档案经上游 sync 与
   PC 网页端同源）。
2. **电脑网页端添加动作单**（计划 → 添加动作单）。电脑直连时，手表从电脑拉取动作单。
   手机中转时，先在手机 App 刷新档案，再由手机发给手表。

## 二、真机安装（AstroBox，免刷机）

社区通用做法，不需要改固件（改固件刷机有变砖风险，勿碰）：

1. 电脑安装 **AstroBox**（https://astrobox.online 下载 Windows 版），登录**米坛账号**
   （bandbbs.cn 注册）。
2. 手表：设置 → **连接新手机**（手表会清空配对，装完再连回手机）。
3. AstroBox → "安装本地快应用/rpk" → 选 `dist\` 下的 rpk → 蓝牙推送安装。
   （手表快应用槽位有限约 10 个，装不下时删掉不用的。）
4. 更新 = 重装同名 rpk（应用数据保留）。

## 三、配对与日常使用

### 电脑配对与离线训练

1. 在电脑运行 openGym 服务器，在网页端添加动作单。确保手表能访问电脑的局域网地址。
2. 电脑网页端打开「设置 → 配对手机应用」，生成 8 位配对码。手表打开「开炼 → 连接设备」，
   点「电脑配对」，先输入电脑局域网 IP（默认端口 8080），再点「下一步」输入配对码。
   IP 可点选常用开头，配对码按「A–M / N–Z / 2–9」切换大键盘。
   点「连接并获取动作单」，看到配对结果后返回首页。
   配对码 5 分钟内有效。成功后换取的连接凭证有效期为 90 天。
3. 离开电脑后，在手表首页点「独立训练」，从缓存的计划中选一套开练。多套动作单可在列表中上下滑动。练完点「保存并同步」。
   连不上电脑时，整场记录会进入手表的待同步队列。
4. 恢复到电脑的网络连接并启动 openGym 后，打开手表 App。手表会自动补传积压记录，
   可以在电脑网页端的训练历史核对。

可在手表首页查看待同步场数。自动化测试覆盖 15 场、每场 18 组，以及重启测试进程和
补传中途断线。实际设备容量、重启手表和真实离线 15 天的验收状态见[产品需求](../docs/prd.md)。

### 手机配对与训练

**首次配对（约 1 分钟）**

1. 确认手表已通过蓝牙连接手机，在安卓手机上打开 openGym 并允许通知。
2. 手表打开「开炼 → 连接设备 → 手机配对」。未配对时，手表会自动检查小米系统通道、
   等待手机 openGym 回应并读取动作单。每一步都可在手表上查看。看到配对结果后返回首页。
   如果自动连接失败，可点「手动输入 IP 和配对码」，按手机 openGym 通知栏显示的
   **局域网 IP 和 8 位数字码**分两步输入（默认端口 8765）。
   数字码在换手机或清除 App 数据后会变。通知未显示时，将 openGym 切回前台。
3. 手机加入**电池白名单**（首次打开会推送引导通知，点它进系统对话框）：MIUI/HyperOS
   可能杀后台 hub，训练中手表会失联；加了白名单 hub 常驻。

排查连接时，进入「设置 → 连接诊断」。点击「系统」后测试 GET 和 POST，可以单独核对小米系统通道。手动输入手机 Wi-Fi IP 可测试手机 HTTP。「对照PC」用于检查电脑直连。

**训练**

1. 手表先开系统**运动模式**（如力量训练），热量/时间/心率归它统计。
2. 打开「开炼」→「同步手机」。手机已有训练时，可跟记当前训练，包括没有动作单的自由训练。
   手机还没开练时，手表会等待。留在首页时只更新状态，成功后每 10 秒刷新，失败后等待 20 秒再试。
3. 每组做完「完成本组」→ 自动休息倒计时（屏幕显示下一组的动作、重量、次数；
   +30 秒 / 跳过休息）。组前可 ±2.5/±0.5 调重量、±1 调次数；「跳过这组」两段点按；
   被跳的组圆点变 ✕、点它找回；单侧组左右两个按钮各记一侧。
4. 全部完成或「结束训练」→ 总结页（组数/体量/PR，热身不计）→ **结束并同步** →
   手表把未发的事件发给手机。手机回执确认收件，训练入账以手机历史为准。
   - 没同步上：事件留在手表队列，下次打开自动补投，收到明确回执的事件才移出。
   - 中途不想练了：总结页「**手表停止跟踪（手机继续）**」——已记的组手机照收，
     手机端训练继续由你在手机上结束。

在首页设备行可切换已保存的连接，也可切到离线模式。从首页「待同步记录」可查看场次、组数、状态并重试。
「设置」可调整独立训练的默认休息及本机休息结束振动，也可进入设备管理、连接诊断、本地存储和关于。
手机缓存动作单可供独立训练使用。手机 1.0.8 支持跟记事件，使用手机动作单开始的独立整场记录暂存手表。
手机待发队列最多 600 条事件，1.0.8 手机收件箱最多 1,200 条。积压超过 200 条需协议 3 的手机 hub。

## 四、目录结构

```
watch-app\
├── src\                      # 快应用源码
│   ├── manifest.json         # 包名 ch.duartesantos.opengym、权限、路由（含 system.interconnect）
│   ├── js\
│   │   ├── api.js            # 传输层：hubCall（/watch/*，interconnect 通道优先、HTTP 回退）+ v1 直连 /api/*（封存）
│   │   ├── ic.js             # @system.interconnect 通道封装（请求/应答、超时、状态缓存）
│   │   ├── hub.js            # v2 协议层：快照同步 / 事件队列（ack 删队）/ 会话胶水
│   │   ├── session-core.js   # SessionCore.swift 移植的状态机，v2 语义核心
│   │   ├── session.js        # v1 会话构建/提交（fallback 分支）
│   │   ├── store.js          # 本地存储 + 震动封装
│   │   └── names.js          # 动作中文名（build-names.mjs 生成，v1 用）
│   └── pages\
│       ├── index\            # 首页 V4：连接状态、双训练入口、待同步提示
│       ├── pair\             # 电脑配对、手机自动连接与手动配对
│       ├── session2\         # v2 会话页：快照驱动 + session-core + 事件队列
│       ├── session\          # v1 会话页（fallback）
│       ├── pick\             # 本地动作单选择
│       ├── settings\         # 休息与振动、设备管理、诊断、存储及关于
│       ├── pending\          # 待同步训练详情及重试
│       └── spike\            # 传输诊断页（GET/POST/连发，目标 IP 独立记忆）
├── hub\                      # 安卓 hub 协议核心（纯 Java）+ PC JVM 契约测试（56 项）
├── vendor\                   # 上游 openGym 的动作名数据（AGPL-3.0，build-names 用）
├── scripts\
│   ├── build-names.mjs       # 生成 names.js（改动作单后重跑，v1 用；数据目录用参数/OPENGYM_DATA 指定）
│   ├── package-rpk.cmd       # 手表 rpk 打包流水线（需环境变量 AIOT_PKG + sign/debug 证书）
│   ├── emu-hub.mjs           # 模拟器/联调用假 hub（0.0.0.0:8765，全家桶快照）
│   ├── emu-drive.mjs         # 模拟器点按/截图驱动（install/flow/seq/tap/touch/shot/log）
│   └── emu-*.mjs             # 各阶段模拟器走查脚本（输出到本目录 emu-*\，可用 EMU_SHOTS 改）
└── test\                     # Node 自动化测试（无需真机），见「五」
```

## 五、自动化测试（Node，无需真机）

`test\` 一套不依赖真机的测试：`@system.*` 特性用桩模块注入，`js\` 源码原样加载；
hub 测试对着真 TCP 的假 hub 跑 v2 全链路。**改动源码后逐个跑、提交前全绿**
（Windows 下逐个跑）：

```
cd /d <本仓>\watch-app
node test\session.test.mjs        # v1 逻辑 15 项
node test\pages.test.mjs          # 页面静态检查 6 项
node test\lifecycle.test.mjs      # 页面生命周期 59 项（hub 开关、免输入配对）
node test\build-names.test.mjs    # build-names 2 项
node test\session-core.test.mjs   # SessionCore 38 项（Swift 用例 1:1）
node test\hub.test.mjs            # v2 协议层 19 项（系统通道、边界/压缩/协商、过期）
```

共 **139 项**。协议核心（纯 Java）另有 PC JVM 门禁：`hub\build.cmd` 56 项——动
s3 契约前必跑。

## 六、模拟器实测（redmi_watch 镜像，与真机同为 Vela 引擎）

需要环境变量 `AIOT_PKG` 指向 aiot-toolkit 打包工程根（emulator SDK 与 node_modules
都在其中）；截图输出到本目录 `emu-*\`，可用 `EMU_SHOTS` 覆盖。

```
cd /d <本仓>\watch-app
node scripts\emu-hub.mjs                 # 起假 hub（0.0.0.0:8765）+ 全家桶快照
node scripts\emu-drive.mjs install       # 重装 rpk + 启动 + 连拍
```

已踩实的坑（模拟器与 Vela 引擎，全部实测）：

- **Vela div 默认主轴是 row**：纵向容器必须显式 `flex-direction: column`。
- **快应用 CSS 不支持 `.a.b` 复合选择器**：状态样式用独立类名且写在基类之后。
- **同一个模拟器实例反复 `vapp`/startApp 会进坏状态**（`lv_nuttx_uv_fb_init fail : -22`，
  渲染在、点按全失效）：装包和首次启动并成一步、每个实例只 startApp 一次；坏了就
  `adb emu kill` 重装。重装 rpk 不清应用存储。
- **Vela 不触发 `onlongpress`**（900ms 松开算 click）：跳过用专用键两段点按。
- **页面高度硬约束 432×514**：加任何行都要先算高度（两轮压缩）。
- 模拟器访问宿主用 `10.0.2.2`（QEMU 用户态网关）；应用数据在 AVD 磁盘上持久。
- `set "VAR=值"` 带引号写环境变量，否则尾随空格进变量值。

## 七、打包

**手表 rpk**（产物 `dist\ch.duartesantos.opengym.debug.<版本>.rpk`，安卓 debug 证书签名；
包名与签名和手机 App 一致是 interconnect 免输入配对的前提）：

```
set AIOT_PKG=<aiot-toolkit 打包工程根>
watch-app\scripts\package-rpk.cmd
```

脚本内做：build-names 重生成 → src 覆盖拷贝到打包工程 → 签名材料（`watch-app\sign\debug\`，
你自己的安卓 debug 证书的 pem，生成方法见 [phone/README.md](../phone/README.md)）拷贝进
打包工程 → `aiot.cmd build` → rpk 拷回 `watch-app\dist\`。改动作单后必须重跑
（names.js 烧进包）。

**手机 APK**：集成 hub 的安卓 App 构建见 [phone/README.md](../phone/README.md)。

**验证**：rpk 装手表（AstroBox，见「二」）→ 配对 → 看一次训练事件进手机；APK 装手机 →
通知栏出现 hub 的 IP·token → PC 上
`curl -H "Authorization: Bearer <token>" http://<手机IP>:8765/watch/ping` 返回
`{"ok":true,...}`。

## 八、已知限制

- **休息倒计时的同步边界（协议 v2.1）**：手表 +30 秒/跳过以事件发给手机（`ping.proto`
  协商；手机端休息计时器正在走且事件新鲜——60 秒内——才生效，屏幕没开就 ack 丢弃不
  排队）。手机端的休息盖章进快照（`rest.at/total`），手表休息页在无未确认事件时跟着
  延长。细则见 [docs/rest-sync.md](../docs/rest-sync.md)。
- **会话过期**：本地会话超过 6 小时（从开局起算）在下次打开会话页时自动离场——
  finish 事件补投给手机，由手机端自己的结束流程落库（已记的组不丢）；wid 进 tombstone，
  旧快照不许复活。页面开着（正在用）不触发。细则见
  [docs/session-expiry.md](../docs/session-expiry.md)。
- **无心率/Health 通道**：红米表快应用没有心率写入通道，watchStatus/setHr 事件暂不接。
- **配对码 8 位**：输错就重试。
- **hub 服务依赖前台通知**：Android 13+ 首启若点掉/先拒绝通知权限，常驻通知可能缺失
  （回到 app 前台自动补发）；服务本身仍在跑，配对可看 app 内。
- **MIUI/HyperOS 杀后台**：靠 START_STICKY 拉回 + 电池白名单引导降低概率；快照缓存被
  清时契约 `snapshot:null` 已覆盖（手表保持本地会话继续记）。
- **不支持的展示**：体重/心率卡片、训练中编辑动作单（回手机做）。

## 许可

本项目随上游 openGym（[DuarteSantos8/openGym](https://github.com/DuarteSantos8/openGym)）
以 **AGPL-3.0** 发布：见仓库根 [LICENSE](../LICENSE)。`vendor\` 内为上游的动作名数据。
