package ch.duartesantos.opengym;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.List;

import ch.duartesantos.opengym.watchhub.WatchJson;

/**
 * The page's end of the watch link on Android (lib/watch-sync.js) — the same plugin
 * interface the iPhone exposes over WatchConnectivity (ios/App/App/WatchBridgePlugin.swift),
 * but the transport is the hub's own HTTP server (WatchHubService): the watch polls the
 * snapshot and posts its events, the queue between "arrived" and "applied by the page"
 * is the same file-backed one the HTTP side writes.
 *
 * Method-for-method the iOS set:
 *
 *   const WatchBridge = registerPlugin('WatchBridge')
 *   await WatchBridge.status()                 // { supported, activated, paired, installed, reachable }
 *   await WatchBridge.sendSnapshot({ json })   // cached for the watch's GET /watch/snapshot
 *   const { events } = await WatchBridge.drain()
 *   await WatchBridge.ack({ ids })
 *   WatchBridge.addListener('watchEvent', ...) // fresh events arrived (the page drains)
 *   await WatchBridge.sendClips({ wid, clips })   // no-op here: the Redmi watch loads no GIFs
 *   await WatchBridge.openOnWatch()               // { ok: false }: iOS opens its watch over HealthKit
 *   await WatchBridge.dropClips()
 *
 * There is no way to ask a Redmi Watch 5 whether the app is installed on it, so
 * paired/installed report the link as up whenever this app runs; reachable says
 * whether the hub service is serving.
 */
@CapacitorPlugin(name = "WatchBridge")
public class WatchBridgePlugin extends Plugin {
    private static WatchBridgePlugin instance;

    @Override
    public void load() {
        WatchHubState.init(getContext());
        instance = this;
        super.load();
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("supported", true);
        ret.put("activated", true);
        // S8 2A: `installed` now comes from the wearable SDK (isWearAppInstalled on the paired
        // node). Where the SDK is not usable (no Xiaomi Wearable service on this phone) it
        // stays `true` — the S3 behaviour — so the app on non-Mi phones is unchanged.
        WatchInterconnect ic = WatchInterconnect.get();
        ret.put("paired", true);
        Boolean installed = ic.wearAppInstalled();
        ret.put("installed", installed == null ? true : installed.booleanValue());
        ret.put("reachable", WatchHubService.isRunning());
        call.resolve(ret);
    }

    @PluginMethod
    public void sendSnapshot(PluginCall call) {
        String json = call.getString("json");
        if (json == null || json.isEmpty()) {
            call.reject("json is required");
            return;
        }
        WatchHubState.get().setSnapshot(json);
        JSObject ret = new JSObject();
        ret.put("sent", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void drain(PluginCall call) {
        JSArray events = new JSArray();
        for (Object o : WatchHubState.get().queue().all()) {
            try {
                events.put(new JSObject(WatchJson.write(o)));
            } catch (Exception ignored) {
                // An event that cannot re-serialize is an event that was never stored.
            }
        }
        JSObject ret = new JSObject();
        ret.put("events", events);
        call.resolve(ret);
    }

    @PluginMethod
    public void ack(PluginCall call) {
        List<String> ids = new ArrayList<String>();
        JSArray arr = call.getArray("ids");
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                try {
                    String id = arr.getString(i);
                    if (id != null) ids.add(id);
                } catch (Exception ignored) {
                }
            }
        }
        WatchHubState.get().queue().ack(ids);
        call.resolve();
    }

    @PluginMethod
    public void sendClips(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("sent", 0);
        ret.put("queued", 0);
        call.resolve(ret);
    }

    @PluginMethod
    public void openOnWatch(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("ok", false);
        call.resolve(ret);
    }

    @PluginMethod
    public void dropClips(PluginCall call) {
        call.resolve();
    }

    /** The service heard new events from the watch: tell the page to drain. */
    static void notifyNewEvents() {
        WatchBridgePlugin p = instance;
        if (p == null) return;
        JSObject data = new JSObject();
        data.put("queued", WatchHubState.get().queue().size());
        p.notifyListeners("watchEvent", data);
    }
}
