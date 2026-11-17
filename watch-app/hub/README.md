# watch-app/hub — 安卓 hub 的协议核心（S3）

S3「安卓 hub」的平台无关部分：手表手机协议（快照下发 / 事件上报 / ack）的路由、
JSON、HTTP 解析和事件队列，全部纯 Java、零 Android 依赖——APK 里编译的就是这几个
类，PC JVM 上测的也是这几个类，`gradlew` 构建前先跑本目录的测试作为门禁。

契约的散文版（路由、请求/响应体、错误码、ack 语义）冻结在
[`docs/android-hub.md`](../../docs/android-hub.md)，代码里 `WatchHub.java` 是它的实现。

## 目录

- `core/java/ch/duartesantos/opengym/watchhub/` — 协议核心（APK 通过
  `android/app/build.gradle` 的 `sourceSets` 直接从这里编译）：
  - `WatchJson.java` — 极简 JSON 解析/写出（整数 → Long；快照从不解析、原样内嵌）
  - `WatchHttp.java` — Vela 手表栈形状的请求解析 + 响应头构造
  - `WatchHub.java` — 路由与鉴权（契约常量：端口 8765、Bearer token、/spike 免鉴权回声）
  - `WatchEventQueue.java` — 手机侧事件队列（按 id 去重追加、ack 删除、500 条上限、
    每次变更立即落盘——队列是事件的最后一份拷贝）
- `javatest/WatchHubTest.java` — PC JVM 测试 54 项：JSON/队列/请求解析单测 + 真实
  套接字上把契约全表打一遍（无鉴权 401、错误码、快照原样返回、重发去重、ack 语义）
- `build.cmd` — 门禁：javac + java，退出码即结果。无需 Android SDK。

## 跑法

```
cd /d <本仓>\watch-app\hub && build.cmd
```

## 安卓侧（集成进上游 App，见 `phone/README.md`）

- `WatchHubState.java` — 单例状态：token（首启生成 8 位数字，存 SharedPreferences）、
  快照缓存 + rev、文件落盘的事件队列（`filesDir/watch-events.json`，临时文件改名原子写）
- `WatchHubService.java` — 前台服务（specialUse，同 RestTimerService/SpikeHub 模式），
  0.0.0.0:8765 + CPU/WiFi 双唤醒锁；通知栏显示「局域网 IP · token」
- `WatchBridgePlugin.java` — Capacitor 插件 `WatchBridge`，方法集与 iOS 逐一对应
  （status / sendSnapshot / drain / ack + sendClips / openOnWatch / dropClips 空实现）

## S4 起的假 hub

`watch-app/test/` 的 node 桩按 s3 文档的契约实现即可；本目录的 PC JVM 测试已把
契约逐条打过，两边对不上时以 s3 文档 + WatchHubTest 为准。
