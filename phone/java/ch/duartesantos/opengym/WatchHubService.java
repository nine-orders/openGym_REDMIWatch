package ch.duartesantos.opengym;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.Enumeration;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import ch.duartesantos.opengym.watchhub.WatchHub;
import ch.duartesantos.opengym.watchhub.WatchHttp;

/**
 * The watch hub's HTTP server, in a foreground service with CPU + WiFi wake locks —
 * the RestTimerService / SpikeHub pattern, so the watch still reaches the phone with
 * it locked in a pocket (the S2 finding this whole architecture rests on). Serves the
 * frozen S3 contract out of WatchHub; a snapshot arrives from the page through the
 * WatchBridge plugin, an event goes back the same way (the plugin notifies the page,
 * which drains when it can — frozen WebView, events simply wait in the queue).
 */
public class WatchHubService extends Service {
    public static final int PORT = WatchHub.PORT; // 8765, same socket the S2 spike used
    private static final String CHANNEL = "watch-hub";
    /** The ongoing notification's id (the S7 re-post reuses it: notify = update if visible). */
    public static final int NOTIF_ID = 2;
    private static final String BATTERY_CHANNEL = "watch-hub-battery";
    private static final int BATTERY_ID = 3;

    private static volatile boolean running;
    private ServerSocket serverSocket;
    private ExecutorService pool;
    private PowerManager.WakeLock cpu;
    private WifiManager.WifiLock wifi;
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        WatchHubState.init(this);
        // S8 2A: the interconnect end of the watch link (same requests, system channel).
        WatchInterconnect.get().start(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startFg();
        holdLocks();
        if (!running) {
            synchronized (WatchHubService.class) {
                if (!running) {
                    running = true;
                    pool = Executors.newCachedThreadPool();
                    new Thread(acceptLoop, "watch-hub-accept").start();
                }
            }
        }
        return START_STICKY;
    }

    /** Whether the accept loop is up — the plugin's status().reachable. */
    public static boolean isRunning() {
        return running;
    }

    @Override
    public void onDestroy() {
        running = false;
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (Exception ignored) { }
        if (pool != null) pool.shutdownNow();
        releaseLocks();
        stopForeground(true);
        super.onDestroy();
    }

    private final Runnable acceptLoop = new Runnable() {
        @Override
        public void run() {
            try {
                serverSocket = new ServerSocket();
                serverSocket.setReuseAddress(true);
                serverSocket.bind(new InetSocketAddress(InetAddress.getByName("0.0.0.0"), PORT), 16);
                while (running) {
                    final Socket s = serverSocket.accept();
                    pool.execute(new Runnable() {
                        @Override
                        public void run() {
                            serve(s);
                        }
                    });
                }
            } catch (Exception e) {
                // The socket died under us (the service is stopping): say so only then.
                if (running) android.util.Log.e("WatchHub", "accept loop failed", e);
            }
        }
    };

    private void serve(Socket s) {
        try {
            s.setSoTimeout(5000);
            InputStream in = new BufferedInputStream(s.getInputStream());
            OutputStream out = new BufferedOutputStream(s.getOutputStream());
            WatchHttp.Request req = WatchHttp.parse(in);
            WatchHttp.Response res = WatchHub.handle(req, WatchHubState.get().env());
            out.write(WatchHttp.headBytes(res));
            out.write(res.body);
            out.flush();
            if (res.status != 200) {
                android.util.Log.w("WatchHub", res.status + " for " + req.method + " " + req.path
                    + " <- " + s.getRemoteSocketAddress());
            } else if ("/watch/events".equals(req.pathOnly()) && "POST".equals(req.method)) {
                // Fresh events on the phone: wake the page if it is alive. A frozen one
                // drains on its own the moment it wakes (lib/watch-sync.js).
                main.post(new Runnable() {
                    @Override
                    public void run() {
                        WatchBridgePlugin.notifyNewEvents();
                    }
                });
            }
        } catch (Exception e) {
            android.util.Log.w("WatchHub", "serve failed: " + e);
        } finally {
            try { s.close(); } catch (Exception ignored) { }
        }
    }

    private void startFg() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        Notification n = buildNotification(this);
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(NOTIF_ID, n);
            }
        } catch (Exception e) {
            android.util.Log.e("WatchHub", "startForeground failed", e);
        }
    }

    /** The ongoing notification, built from the shared state (an IP and token the watch types). */
    static Notification buildNotification(Context ctx) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        String text = lanIp() + "  token " + WatchHubState.get().token();
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(
                CHANNEL, "Watch hub", NotificationManager.IMPORTANCE_LOW));
            return new Notification.Builder(ctx, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle("openGym watch hub :" + PORT)
                .setContentText(text)
                .setOngoing(true)
                .build();
        }
        return new Notification.Builder(ctx)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("openGym watch hub :" + PORT)
            .setContentText(text)
            .setOngoing(true)
            .build();
    }

    /**
     * Re-posts the ongoing notification (same id — a no-op update when it is already visible).
     * Android 13+ grants POST_NOTIFICATIONS only after the user answers the prompt; the service's
     * startForeground ran before the grant, the system dropped the notification and the shade
     * stayed empty (docs/watch-v2/s7-real-device.md 发现 2: "看似没有通知", recovered by killing
     * the app). The activity calls this from onResume, so the first foreground after the grant
     * (or after a late enable in system settings) shows the IP and token again.
     */
    public static void reNotify(Context ctx) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (!nm.areNotificationsEnabled()) return;
        try {
            nm.notify(NOTIF_ID, buildNotification(ctx));
        } catch (Exception e) {
            android.util.Log.w("WatchHub", "re-notify failed", e);
        }
    }

    /**
     * One-shot guidance into the battery whitelist (docs/watch-v2/s7-real-device.md 发现 4:
     * MIUI/HyperOS killed the hub in the background once, START_STICKY pulled it back but the
     * snapshot cache cleared). Posts a notification whose tap opens the system "ignore battery
     * optimizations" dialog for this app, and cancels itself once the app is whitelisted.
     * No hard dependency: the pages that fail later degrade per the contract (snapshot:null).
     */
    public static void guideBattery(Context ctx) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (!nm.areNotificationsEnabled()) return;
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        if (pm.isIgnoringBatteryOptimizations(ctx.getPackageName())) {
            nm.cancel(BATTERY_ID);
            return;
        }
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(
                BATTERY_CHANNEL, "Watch hub battery", NotificationManager.IMPORTANCE_HIGH));
        }
        Intent it = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
            Uri.parse("package:" + ctx.getPackageName()));
        PendingIntent pi = PendingIntent.getActivity(ctx, 0, it,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = (Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(ctx, BATTERY_CHANNEL)
            : new Notification.Builder(ctx))
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("openGym watch hub 需要电池白名单")
            .setContentText("MIUI/HyperOS 可能杀掉后台 hub，训练时手表会失联。点此加入白名单。")
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build();
        nm.notify(BATTERY_ID, n);
    }

    /** The first site-local IPv4 there is; the notification shows it for the watch's pairing. */
    static String lanIp() {
        try {
            Enumeration<NetworkInterface> ifs = NetworkInterface.getNetworkInterfaces();
            while (ifs.hasMoreElements()) {
                NetworkInterface ni = ifs.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                Enumeration<InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress a = addrs.nextElement();
                    if (a.isSiteLocalAddress()) return a.getHostAddress();
                }
            }
        } catch (Exception ignored) { }
        return "<no wifi ip>";
    }

    /** Keeps CPU and WiFi up while the phone is locked — the S2-tested pattern. */
    private void holdLocks() {
        try {
            if (cpu == null) {
                PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
                cpu = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "opengym:watch-hub-cpu");
                cpu.setReferenceCounted(false);
            }
            if (!cpu.isHeld()) cpu.acquire();
            if (wifi == null) {
                WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                wifi = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "opengym:watch-hub-wifi");
                wifi.setReferenceCounted(false);
            }
            if (!wifi.isHeld()) wifi.acquire();
        } catch (Exception e) {
            android.util.Log.w("WatchHub", "wake locks failed: " + e);
        }
    }

    private void releaseLocks() {
        try { if (cpu != null && cpu.isHeld()) cpu.release(); } catch (Exception ignored) { }
        try { if (wifi != null && wifi.isHeld()) wifi.release(); } catch (Exception ignored) { }
    }
}
