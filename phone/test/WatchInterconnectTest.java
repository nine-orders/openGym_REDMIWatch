package ch.duartesantos.opengym;

import android.content.Context;
import android.os.Handler;
import com.xiaomi.xms.wearable.Wearable;
import com.xiaomi.xms.wearable.node.Node;
import ch.duartesantos.opengym.watchhub.WatchJson;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/** Runs the actual Android bridge against controllable SDK callbacks, without a phone. */
public class WatchInterconnectTest {
    public static void main(String[] args) throws Exception {
        WatchInterconnect bridge = WatchInterconnect.get();
        bridge.start(new Context());
        check(Wearable.messages.listener == null, "no node yet");
        Wearable.nodes.nodes = List.of(new Node("watch", "Redmi"));
        Wearable.nodes.installedFailure = true;
        Wearable.auth.fail = true;
        Handler.tick();
        check(bridge.hasNode(), "late node discovered without reopening phone app");
        check(Wearable.messages.listener == null, "permission failure does not register");
        Wearable.auth.fail = false;
        Wearable.auth.notifyOnly = true;
        Handler.tick();
        check(Wearable.messages.adds == 0, "unrelated permission does not register");
        Wearable.auth.notifyOnly = false;
        Wearable.messages.failAdd = true;
        Handler.tick();
        check(Wearable.messages.adds == 1, "parcelled DEVICE_MANAGER grant registers despite failed install lookup");
        Wearable.messages.failAdd = false;
        Handler.tick();
        check(Wearable.messages.listener != null && Wearable.messages.adds == 2, "failed listener registration retried");
        Handler.tick();
        check(Wearable.messages.adds == 2, "stable link not registered twice");
        Wearable.service.disconnect();
        Wearable.messages.listener = null; // SDK process lost the subscription
        Wearable.nodes.installedFailure = false;
        Wearable.service.connect();
        check(Wearable.messages.listener != null && Wearable.messages.adds == 3, "same watch reattached after service reconnect");
        check(WatchBridgePlugin.linkChanges > 0, "frontend gets link change notification");
        Map<?, ?> ping = send("{\"id\":\"p\",\"method\":\"GET\",\"path\":\"/watch/ping\"}");
        check("p".equals(ping.get("id")) && Number.class.cast(ping.get("status")).intValue() == 200
                && String.valueOf(ping.get("body")).contains("\"ok\":true"), "GET correlated JSON reply (not HTTP reason phrase)");
        Map<?, ?> snap = send("{\"id\":\"s\",\"method\":\"GET\",\"path\":\"/watch/snapshot\"}");
        check(String.valueOf(snap.get("body")).contains("\"snapshot\"") && String.valueOf(snap.get("body")).contains("推日"), "GET snapshot preserves UTF-8 plan JSON");
        Map<?, ?> event = send("{\"id\":\"e\",\"method\":\"POST\",\"path\":\"/watch/events\",\"body\":{\"events\":[{\"id\":\"record\"}]}}");
        check(String.valueOf(event.get("body")).contains("\"acked\":[\"record\"]"), "POST receives persisted-id ack");
        check(WatchBridgePlugin.eventNotifications == 1, "POST wakes frontend drain");
        send("{\"id\":\"retry\",\"method\":\"POST\",\"path\":\"/watch/events\",\"body\":{\"events\":[{\"id\":\"record\"}]}}");
        check(WatchHubState.get().queuedEvents().size() == 1, "lost response retry dedupes event on actual queue");
        Map<?, ?> invalid = send("{\"id\":\"x\",\"method\":\"GET\",\"path\":\"/not-found\"}");
        check(Number.class.cast(invalid.get("status")).intValue() == 404 && String.valueOf(invalid.get("body")).contains("not_found"), "error response preserves code and JSON");
        bridge.stop();
        Handler.tick();
        check(Wearable.service.listener == null && Wearable.messages.listener == null && !bridge.hasNode(), "service stop unregisters and cancels refresh");
        System.out.println("WatchInterconnectTest PASS (16 checks)");
    }

    private static Map<?, ?> send(String request) throws Exception {
        Wearable.messages.listener.onMessageReceived("watch", request.getBytes(StandardCharsets.UTF_8));
        return (Map<?, ?>) WatchJson.parse(new String(Wearable.messages.reply, StandardCharsets.UTF_8));
    }
    private static void check(boolean ok, String description) {
        if (!ok) throw new AssertionError(description);
        System.out.println("  ok  " + description);
    }
}
