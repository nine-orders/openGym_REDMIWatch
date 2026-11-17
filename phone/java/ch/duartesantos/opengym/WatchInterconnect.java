package ch.duartesantos.opengym;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

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

    private static volatile WatchInterconnect instance;

    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile Context appContext;         // the service's application context
    private volatile boolean listening;
    private volatile String nodeId;              // the one paired watch (v1.4: 一次只能连一个设备)
    private volatile String nodeName;
    private volatile Boolean wearAppInstalled;   // null = unknown

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
        appContext = ctx.getApplicationContext();
        try {
            ServiceApi serviceApi = Wearable.getServiceApi(ctx);
            serviceApi.registerServiceConnectionListener(new OnServiceConnectionListener() {
                @Override
                public void onServiceConnected() { refresh(ctx); }

                @Override
                public void onServiceDisconnected() {
                    nodeId = null;
                    wearAppInstalled = null;
                }
            });
        } catch (Throwable e) {
            android.util.Log.w(TAG, "wearable SDK unavailable here: " + e);
        }
        refresh(ctx);
    }

    private void refresh(Context ctx) {
        try {
            NodeApi api = Wearable.getNodeApi(ctx);
            api.getConnectedNodes().addOnSuccessListener(nodes -> {
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
                    nodeId = null;
                    nodeName = null;
                    wearAppInstalled = null;
                    return;
                }
                final boolean changed = !id.equals(nodeId);
                nodeId = id;
                nodeName = name;
                api.isWearAppInstalled(id).addOnSuccessListener(installed -> {
                    wearAppInstalled = installed;
                    Log.i(TAG, "node " + id + " (" + name + ") wearAppInstalled=" + installed);
                    if (changed) attach(ctx, id);
                });
            });
        } catch (Throwable e) {
            Log.w(TAG, "node refresh failed: " + e);
        }
    }

    private void attach(Context ctx, String id) {
        if (listening) return;
        try {
            AuthApi auth = Wearable.getAuthApi(ctx);
            auth.requestPermission(id, Permission.DEVICE_MANAGER)
                .addOnSuccessListener(ok -> attachListener(ctx, id))
                .addOnFailureListener(e -> android.util.Log.w(TAG, "DEVICE_MANAGER refused: " + e));
        } catch (Throwable e) {
            android.util.Log.w(TAG, "permission request failed: " + e);
        }
    }

    private void attachListener(Context ctx, String id) {
        try {
            MessageApi messageApi = Wearable.getMessageApi(ctx);
            messageApi.addListener(id, new OnMessageReceivedListener() {
                @Override
                public void onMessageReceived(String fromNode, byte[] message) {
                    handle(fromNode, message);
                }
            }).addOnSuccessListener(v -> {
                listening = true;
                android.util.Log.i(TAG, "message listener on " + id);
            }).addOnFailureListener(e -> android.util.Log.w(TAG, "listener add failed: " + e));
        } catch (Throwable e) {
            android.util.Log.w(TAG, "listener setup failed: " + e);
        }
    }

    /** The region the watch sees in WatchBridge.status(): paired / installed from the real nodes. */
    public boolean hasNode() {
        return nodeId != null;
    }

    public Boolean wearAppInstalled() {
        return wearAppInstalled;
    }

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
        reply.put("body", res.text == null ? "" : res.text);
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
            Wearable.getMessageApi(c).sendMessage(toNode, json.getBytes(StandardCharsets.UTF_8));
        } catch (Throwable e) {
            android.util.Log.w(TAG, "reply send failed: " + e);
        }
    }
}