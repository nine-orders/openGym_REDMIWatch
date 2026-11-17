# 手机端（安卓 openGym App）watch hub 集成

手表的 v2 架构里，手机是处方引擎 + 同步枢纽（hub）：一个前台 HTTP 服务（`:8765`）把
训练快照发给手表、收手表的记组事件并落库。手表走小米运动健康的蓝牙代理到达这个服务，
或走 `@system.interconnect` 系统通道（免输入配对）。协议见 [docs/android-hub.md](../docs/android-hub.md)
与 [docs/watch-protocol.md](../docs/watch-protocol.md)。

PC 服务器侧不需要任何改动。

## 这里有什么

```
phone\
├── java\ch\duartesantos\opengym\
│   ├── WatchHubService.java      # 前台服务：HTTP :8765、常驻通知（IP·token）、电池白名单引导
│   ├── WatchHubState.java        # 配对 token、待发事件队列的持久化
│   ├── WatchInterconnect.java    # @system.interconnect 系统通道（xms-wearable SDK）
│   └── WatchBridgePlugin.java    # Capacitor 插件：WebView(前端 JS) ↔ hub 的桥
└── frontend-lib\
    ├── watch-sync.js             # 快照构建 + 手表事件应用（基于上游同名文件扩展，覆盖使用）
    └── watch-settings.js         # 手表端偏好读写
```

协议核心（纯 Java，四个类共用的 JSON 解析/事件队列/HTTP 契约）在
[`watch-app/hub/core`](../watch-app/hub/)，`build.cmd` 可在 PC 上跑完整契约测试（无需安卓 SDK）。

## 集成步骤（以上游 DuarteSantos8/openGym 的 android 工程为底）

1. **拷 Java**：把 `java/ch/duartesantos/opengym/` 下四个类，连同
   `watch-app/hub/core/java/ch/duartesantos/opengym/watchhub/` 的协议核心，
   放进 `android/app/src/main/java/ch/duartesantos/opengym/`（同包，无需改 package）。
2. **拷前端库**：`frontend-lib/watch-sync.js`、`watch-settings.js` 覆盖进前端
   `src/lib/`（watch-sync.js 在上游 Apple Watch 版同名文件基础上扩展了 v2.1 休息同步、
   hub 通道等；接口兼容，应用侧接线方式与上游 iOS 版相同）。
3. **xms-wearable SDK**：上游安卓工程自带 `android/app/libs/xms-wearable-lib_*.aar`
   （interconnect 依赖），无需额外下载。
4. **MainActivity 接线**（`onCreate` 注册插件并拉起服务，`onResume` 补发通知）：

   ```java
   registerPlugin(WatchBridgePlugin.class);
   // The watch hub serves the paired watch for as long as the app process lives:
   // started at every open, START_STICKY brings it back after the system kills the process.
   Intent watchHub = new Intent(this, WatchHubService.class);
   if (Build.VERSION.SDK_INT >= 26) startForegroundService(watchHub);
   else startService(watchHub);
   // MIUI/HyperOS battery whitelist guidance: a notification whose tap opens
   // the system dialog; it cancels itself once the app is whitelisted.
   WatchHubService.guideBattery(this);
   ```

   ```java
   @Override
   public void onResume() {
       super.onResume();
       // The hub's notification may have been swallowed by the POST_NOTIFICATIONS grant
       // race: every foreground while the hub runs re-posts it (same id — an update).
       if (WatchHubService.isRunning()) {
           WatchHubService.reNotify(this);
           WatchHubService.guideBattery(this);
       }
   }
   ```

5. **AndroidManifest 接线**（`<application>` 内声明服务 + 权限）：

   ```xml
   <service
       android:name=".WatchHubService"
       android:exported="false"
       android:foregroundServiceType="specialUse">
       <property
           android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"
           android:value="Serves the paired Redmi watch over the local network so it can run the workout on its own." />
   </service>
   ```

   ```xml
   <!-- Watch hub battery whitelist: lets the guidance notification open the system
        "ignore battery optimizations" dialog for this app. -->
   <uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />
   <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
   <uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE" />
   ```

   （`INTERNET`/`POST_NOTIFICATIONS`/`WAKE_LOCK` 等上游已具备。）

6. **包名一致性**：`build.gradle` 的 `applicationId` 必须与快应用 `manifest.json` 的
   `package` **完全一致**（本仓默认 `ch.duartesantos.opengym`），否则 interconnect 配对不上。
7. **构建 APK**：JDK21 + `npx vite build`（`VITE_MOBILE=1`）→ `npx cap sync android` →
   `gradle :app:assembleSideloadDebug`（或你的变体）。细节见 [docs/android-hub.md](../docs/android-hub.md)。

## 生成手表 rpk 的调试签名材料

rpk 与 APK 要**同一证书签名**（interconnect 的前提）。调试证书从你本机默认的
Android debug.keystore 转换（jks → p12 → pem，标准做法、以小米快应用官方文档为准）：

```bash
keytool -importkeystore -srckeystore ~/.android/debug.keystore \
        -srcstorepass android \
        -destkeystore debug.p12 -deststoretype PKCS12 -deststorepass android
openssl pkcs12 -in debug.p12 -nokeys  -out certificate.pem -passin pass:android
openssl pkcs12 -in debug.p12 -nodes -nocerts -out private.pem   -passin pass:android
```

把两个 pem 放到 `watch-app/sign/debug/`（已 gitignore，永不入库）。正式发布请用
你自己的 release 密钥走同样的转换。
