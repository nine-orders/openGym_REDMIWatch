package ch.duartesantos.opengym;

import android.content.Context;
import android.content.SharedPreferences;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.List;

import ch.duartesantos.opengym.watchhub.WatchEventQueue;
import ch.duartesantos.opengym.watchhub.WatchHub;

/**
 * The hub's one state, shared by the service (the watch's HTTP requests) and the
 * plugin (the page's drain/ack and snapshots) — both live in the same process, so a
 * plain singleton carries it. The token and the event queue outlive the process:
 * the token in SharedPreferences, the queue in a file, written at once on every
 * change (the queue is an event's last copy until the page has applied it).
 */
public final class WatchHubState {

    private static final String PREFS = "watch_hub";
    private static final String PREF_TOKEN = "token";
    private static final String QUEUE_FILE = "watch-events.json";

    private static volatile WatchHubState instance;

    private final String token;
    private final File queueFile;
    private final WatchEventQueue queue;

    // The latest snapshot, exactly as the page sent it, plus the counter the watch
    // reads to skip a re-read. Memory-only by design: a restarted app re-sends on boot.
    private final Object snapLock = new Object();
    private String snapshotJson;
    private int snapshotRev;

    private WatchHubState(Context ctx) {
        SharedPreferences prefs = ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String t = prefs.getString(PREF_TOKEN, null);
        if (t == null || t.length() != 8) {
            // Eight digits: short enough to type on the watch once, long enough that a
            // drive-by guess on the gym's WiFi is not a plan.
            SecureRandom rnd = new SecureRandom();
            StringBuilder sb = new StringBuilder(8);
            for (int i = 0; i < 8; i++) sb.append((char) ('0' + rnd.nextInt(10)));
            t = sb.toString();
            prefs.edit().putString(PREF_TOKEN, t).apply();
        }
        token = t;
        queueFile = new File(ctx.getApplicationContext().getFilesDir(), QUEUE_FILE);
        queue = WatchEventQueue.load(new WatchEventQueue.Storage() {
            public byte[] read() {
                try {
                    FileInputStream in = new FileInputStream(queueFile);
                    try {
                        byte[] data = new byte[(int) queueFile.length()];
                        int off = 0;
                        while (off < data.length) {
                            int r = in.read(data, off, data.length - off);
                            if (r < 0) break;
                            off += r;
                        }
                        return off == data.length ? data : null;
                    } finally {
                        in.close();
                    }
                } catch (Exception e) {
                    return null; // first run, or the file is gone: an empty queue
                }
            }

            public void write(byte[] data) {
                // Write beside, then over: a write cut short never takes the last good copy down.
                File tmp = new File(queueFile.getParentFile(), QUEUE_FILE + ".tmp");
                try {
                    FileOutputStream out = new FileOutputStream(tmp);
                    out.write(data);
                    out.flush();
                    out.getFD().sync();
                    out.close();
                    if (!tmp.renameTo(queueFile)) {
                        FileOutputStream direct = new FileOutputStream(queueFile);
                        direct.write(data);
                        direct.close();
                    }
                } catch (Exception ignored) {
                }
            }
        });
    }

    /** Idempotent; both the plugin's load() and the service's onCreate call it. */
    public static synchronized void init(Context ctx) {
        if (instance == null) instance = new WatchHubState(ctx);
    }

    public static WatchHubState get() {
        if (instance == null) throw new IllegalStateException("WatchHubState.init not called");
        return instance;
    }

    String token() {
        return token;
    }

    void setSnapshot(String json) {
        synchronized (snapLock) {
            snapshotJson = json;
            snapshotRev++;
        }
    }

    WatchEventQueue queue() {
        return queue;
    }

    /** The router's view of this state, for the service's request handling. */
    WatchHub.Env env() {
        return new WatchHub.Env() {
            public String token() { return token; }

            public String snapshotJson() {
                synchronized (snapLock) {
                    return snapshotJson;
                }
            }

            public int snapshotRev() {
                synchronized (snapLock) {
                    return snapshotRev;
                }
            }

            public List<String> storeEvents(List<Object> events) {
                return queue.append(events);
            }

            public List<Object> queuedEvents() {
                return queue.all();
            }
        };
    }
}
