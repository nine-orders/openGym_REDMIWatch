package ch.duartesantos.opengym;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

import com.xiaomi.xms.wearable.Wearable;
import com.xiaomi.xms.wearable.auth.AuthApi;
import com.xiaomi.xms.wearable.auth.Permission;
import com.xiaomi.xms.wearable.message.MessageApi;
import com.xiaomi.xms.wearable.message.OnMessageReceivedListener;
import com.xiaomi.xms.wearable.node.Node;
import com.xiaomi.xms.wearable.node.NodeApi;
import com.xiaomi.xms.wearable.service.OnServiceConnectionListener;
import com.xiaomi.xms.wearable.service.ServiceApi;

import ch.duartesantos.opengym.watchhub.WatchHttp;
import ch.duartesantos.opengym.watchhub.WatchHub;
import ch.duartesantos.opengym.watchhub.WatchJson;

/**
 * The phone's end of the S8 2A interconnect channel (docs/watch-v2/s8-pairing-probe.md,
 * 小米穿戴第三方APP能力开放接口 v1.4): the system-routed watch ↔ companion-app link, the
 * Redmi equivalent of iOS WatchConnectivity. The watch hands the exact same requests the
 * HTTP hub serves ({id, method, path, body}) and this bridge runs them through the frozen
 * WatchHub routes byte-for-byte — the token is the hub's own, injected here because the
 * channel itself is already bound to this app by package name + signature. Answers go back
 * as {id, status, body} over MessageApi. Nothing else from the channel is trusted.
 *
 * The wearable SDK's service lives in the Xiaomi Wearable app on the phone; on a device
 * without it, every call races into a failure and the bridge just reports unavailable (the
 * watch then falls back to the manual IP+token pairing).
 */
public final class WatchInterconnect {

    private static final String TAG = "WatchInterconnect";
    private static final long REFRESH_MS = 10000;

    private static volatile WatchInterconnect instance;

    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile Context appContext;         // the service's application context
    private volatile String listeningId;
    private String attachingId;
    private volatile int generation;
    private int refreshSerial;
    private volatile int attachSerial;
    private OnServiceConnectionListener serviceListener;
    private volatile String nodeId;              // the one paired watch (v1.4: 一次只能连一个设备)
    private volatile String nodeName;
    private volatile Boolean wearAppInstalled;   // null = unknown

    private final Runnable refreshLoop = new Runnable() {
        @Override public void run() {
            Context c = appContext;
            if (c == null) return;
            refresh(c);
            main.postDelayed(this, REFRESH_MS);
        }
    };

    private WatchInterconnect() { }

    public static WatchInterconnect get() {
        if (instance == null) {
            synchronized (WatchInterconnect.class) {
                if (instance == null) instance = new WatchInterconnect();
            }
        }
        return instance;
    }

    /** Called from the hub's foreground service (start once the app is up). */
    public void start(Context ctx) {
        if (appContext != null) return;
        final Context c = ctx.getApplicationContext();
        appContext = c;
        try {
            ServiceApi serviceApi = Wearable.getServiceApi(c);
            serviceListener = new OnServiceConnectionListener() {
                @Override
                public void onServiceConnected() {
                    main.post(() -> { if (appContext == c && serviceListener == this) refresh(c); });
                }

                @Override
                public void onServiceDisconnected() {
                    main.post(() -> {
                        if (appContext == c && serviceListener == this) {
                            refreshSerial++;
                            resetNode(c, null, null, false);
                        }
                    });
                }
            };
            serviceApi.registerServiceConnectionListener(serviceListener);
        } catch (Throwable e) {
            android.util.Log.w(TAG, "wearable SDK unavailable here: " + e);
        }
        refreshLoop.run();
    }

    public void stop() {
        Context c = appContext;
        if (c == null) return;
        appContext = null;
        refreshSerial++;
        main.removeCallbacks(refreshLoop);
        resetNode(c, null, null, true);
        try {
            if (serviceListener != null) Wearable.getServiceApi(c).unregisterServiceConnectionListener(serviceListener);
        } catch (Throwable e) { Log.w(TAG, "service unregister failed: " + e); }
        serviceListener = null;
    }

    // All lifecycle/callback state changes run on main. A Bluetooth/service reconnect
    // (even with the same node ID) must invalidate the former listener registration.
    private void resetNode(Context ctx, String id, String name, boolean remove) {
        boolean changed = nodeId != null || id != null || listeningId != null;
        String previous = listeningId != null ? listeningId : attachingId;
        generation++;
        nodeId = id;
        nodeName = name;
        wearAppInstalled = null;
        listeningId = null;
        attachingId = null;
        if (remove && previous != null) {
            try { Wearable.getMessageApi(ctx).removeListener(previous); }
            catch (Throwable e) { Log.w(TAG, "listener remove failed: " + e); }
        }
        if (changed) WatchBridgePlugin.notifyWatchState();
    }

    private void refresh(Context ctx) {
        final int request = ++refreshSerial;
        try {
            NodeApi api = Wearable.getNodeApi(ctx);
            api.getConnectedNodes().addOnSuccessListener(nodes -> main.post(() -> {
                if (appContext != ctx || refreshSerial != request) return;
                final String id;
                final String name;
                if (nodes != null && !nodes.isEmpty()) {
                    Node n = nodes.get(0);
                    id = n.id;
                    name = n.name;
                } else {
                    id = null;
                    name = null;
                }
                if (id == null || id.isEmpty()) {
                    if (nodeId != null) resetNode(ctx, null, null, true);
                    return;
                }
                if (!id.equals(nodeId)) resetNode(ctx, id, name, true);
                // Installation status is diagnostic only. A failed/stale lookup must
                // not prevent requests from a watch that can already send messages.
                attach(ctx, id);
                try {
                    api.isWearAppInstalled(id).addOnSuccessListener(installed -> main.post(() -> {
                        if (appContext != ctx || refreshSerial != request || !id.equals(nodeId)) return;
                        if (!Objects.equals(wearAppInstalled, installed)) {
                            wearAppInstalled = installed;
                            Log.i(TAG, "node wearAppInstalled=" + installed);
                            WatchBridgePlugin.notifyWatchState();
                        }
                    })).addOnFailureListener(e -> Log.w(TAG, "watch install query failed: " + e));
                } catch (Throwable e) { Log.w(TAG, "watch install query failed: " + e); }
            })).addOnFailureListener(e -> Log.w(TAG, "connected nodes query failed: " + e));
        } catch (Throwable e) {
            Log.w(TAG, "node refresh failed: " + e);
        }
    }

    private void attach(Context ctx, String id) {
        if (id.equals(listeningId) || id.equals(attachingId)) return;
        attachingId = id;
        final int gen = generation;
        final int attempt = ++attachSerial;
        // Some SDK calls never complete when its service disappears. Release the
        // in-flight marker so the scheduled refresh can try again.
        main.postDelayed(() -> attachFailed(ctx, id, gen, attempt, "listener attach timed out"), 15000);
        try {
            AuthApi auth = Wearable.getAuthApi(ctx);
            auth.requestPermission(id, Permission.DEVICE_MANAGER)
                .addOnSuccessListener(permissions -> main.post(() -> {
                    if (!attaching(ctx, id, gen, attempt)) return;
                    if (!hasDeviceManager(permissions)) {
                        attachFailed(ctx, id, gen, attempt, "DEVICE_MANAGER not granted");
                    } else attachListener(ctx, id, gen, attempt);
                }))
                .addOnFailureListener(e -> main.post(() -> attachFailed(ctx, id, gen, attempt, "DEVICE_MANAGER refused: " + e)));
        } catch (Throwable e) {
            attachFailed(ctx, id, gen, attempt, "permission request failed: " + e);
        }
    }

    private static boolean hasDeviceManager(Permission[] permissions) {
        if (permissions == null) return false;
        // The SDK reconstructs Permission objects from Binder parcels and uses identity equality.
        String required = Permission.DEVICE_MANAGER.getName();
        for (Permission permission : permissions) {
            if (permission != null && required.equals(permission.getName())) return true;
        }
        return false;
    }

    private boolean attaching(Context ctx, String id, int gen, int attempt) {
        return appContext == ctx && generation == gen && attachSerial == attempt && id.equals(attachingId);
    }

    private void attachFailed(Context ctx, String id, int gen, int attempt, String why) {
        if (!attaching(ctx, id, gen, attempt)) return;
        attachingId = null;
        Log.w(TAG, why);
    }

    private void attachListener(Context ctx, String id, int gen, int attempt) {
        try {
            MessageApi messageApi = Wearable.getMessageApi(ctx);
            messageApi.addListener(id, new OnMessageReceivedListener() {
                @Override
                public void onMessageReceived(String fromNode, byte[] message) {
                    if (generation == gen && attachSerial == attempt && id.equals(nodeId)) handle(fromNode, message);
                }
            }).addOnSuccessListener(v -> main.post(() -> {
                if (!attaching(ctx, id, gen, attempt)) return;
                attachingId = null;
                listeningId = id;
                Log.i(TAG, "message listener ready");
                WatchBridgePlugin.notifyWatchState();
            })).addOnFailureListener(e -> main.post(() -> attachFailed(ctx, id, gen, attempt, "listener add failed: " + e)));
        } catch (Throwable e) {
            attachFailed(ctx, id, gen, attempt, "listener setup failed: " + e);
        }
    }

    /** The region the watch sees in WatchBridge.status(): paired / installed from the real nodes. */
    public boolean hasNode() {
        return nodeId != null;
    }

    public Boolean wearAppInstalled() {
        return wearAppInstalled;
    }

    public boolean isListening() { return listeningId != null; }

    private void handle(String fromNode, byte[] message) {
        Object root;
        try {
            root = WatchJson.parse(new String(message, StandardCharsets.UTF_8));
        } catch (WatchJson.ParseException e) {
            android.util.Log.w(TAG, "unparseable channel message");
            return;
        }
        if (!(root instanceof Map)) return;
        Map<?, ?> m = (Map<?, ?>) root;
        Object oid = m.get("id");
        Object opath = m.get("path");
        Object omethod = m.get("method");
        if (!(oid instanceof String) || !(opath instanceof String) || !(omethod instanceof String)) {
            android.util.Log.w(TAG, "malformed channel request");
            return;
        }
        String id = (String) oid;
        String path = (String) opath;
        String method = ((String) omethod).toUpperCase();
        Log.i(TAG, "request " + method + " " + path);
        byte[] body = new byte[0];
        Object obody = m.get("body");
        if (obody != null) {
            try {
                body = WatchJson.write(obody).getBytes(StandardCharsets.UTF_8);
            } catch (Throwable e) {
                body = String.valueOf(obody).getBytes(StandardCharsets.UTF_8);
            }
        }
        // The channel is bound to this app by package + signature: inject the hub's own
        // token and hand off to the exact routes the HTTP server serves.
        Map<String, String> headers = new LinkedHashMap<String, String>();
        String token = WatchHubState.get().token();
        headers.put("Authorization", "Bearer " + token);
        WatchHttp.Request req = WatchHttp.request(method, path, headers, body);
        WatchHttp.Response res = WatchHub.handle(req, WatchHubState.get().env());

        Map<String, Object> reply = new LinkedHashMap<String, Object>();
        reply.put("id", id);
        reply.put("status", (long) res.status);
        // WatchHttp.Response.text is the HTTP reason phrase ("OK"), not JSON.
        // The IC transport must return the exact UTF-8 response bytes that HTTP serves.
        reply.put("body", new String(res.body, StandardCharsets.UTF_8));
        Log.i(TAG, "response " + method + " " + path + " status=" + res.status + " bytes=" + res.body.length);
        send(fromNode, WatchJson.write(reply));

        if ("/watch/events".equals(path) && "POST".equals(method) && res.status == 200) {
            // Fresh events on the phone: wake the page if it is alive (the HTTP path's rule).
            main.post(new Runnable() {
                @Override
                public void run() {
                    WatchBridgePlugin.notifyNewEvents();
                }
            });
        }
    }

    private void send(String toNode, String json) {
        try {
            Context c = appContext;
            if (c == null) return;
            Wearable.getMessageApi(c).sendMessage(toNode, json.getBytes(StandardCharsets.UTF_8))
                .addOnSuccessListener(v -> Log.i(TAG, "reply sent"))
                .addOnFailureListener(e -> Log.w(TAG, "reply send failed: " + e));
        } catch (Throwable e) {
            android.util.Log.w(TAG, "reply send failed: " + e);
        }
    }
}
