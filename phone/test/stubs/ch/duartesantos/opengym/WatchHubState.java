package ch.duartesantos.opengym;
import ch.duartesantos.opengym.watchhub.WatchHub;
import ch.duartesantos.opengym.watchhub.WatchEventQueue;
import java.util.List;
public class WatchHubState implements WatchHub.Env {
    private static final WatchHubState STATE = new WatchHubState();
    public static WatchHubState get() { return STATE; }
    public WatchHub.Env env() { return this; }
    public String token() { return "12345678"; }
    public String snapshotJson() { return "{\"active\":null,\"ready\":{\"today\":{\"name\":\"推日\"}}}"; }
    public int snapshotRev() { return 1; }
    private final WatchEventQueue queue = WatchEventQueue.load(new WatchEventQueue.Storage() {
        private byte[] persisted;
        public byte[] read() { return persisted; }
        public void write(byte[] bytes) { persisted = bytes; }
    });
    public List<String> storeEvents(List<Object> items) { return queue.append(items); }
    public List<Object> queuedEvents() { return queue.all(); }
}
