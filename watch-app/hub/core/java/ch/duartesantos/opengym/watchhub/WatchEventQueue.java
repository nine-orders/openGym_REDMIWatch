package ch.duartesantos.opengym.watchhub;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The phone-side event queue: what arrived from the watch but has not been applied and
 * acknowledged by the page yet. It deduplicates by event id at arrival and is
 * drained and acked through the WatchBridge plugin once the page has applied each event
 * and saved. Until then the queue is the event's last copy, so every change is written
 * back to storage at once.
 *
 * The storage seam keeps this class free of Android imports: the service plugs in the
 * app's files directory, the PC JVM test an in-memory array.
 */
public final class WatchEventQueue {
    public static final int CAP = 1200;

    public interface Storage {
        /** The stored bytes, or null when nothing is stored yet. */
        byte[] read();

        /** Replaces the stored bytes (atomic on the caller's side). */
        void write(byte[] data);
    }

    private final Storage storage;
    private final List<Object> events = new ArrayList<Object>();
    private final Set<String> ids = new HashSet<String>();

    private WatchEventQueue(Storage storage) {
        this.storage = storage;
    }

    public static WatchEventQueue load(Storage storage) {
        WatchEventQueue q = new WatchEventQueue(storage);
        byte[] data = storage.read();
        if (data != null) {
            try {
                Object root = WatchJson.parse(new String(data, StandardCharsets.UTF_8));
                if (root instanceof List) {
                    for (Object o : (List<?>) root) {
                        String id = idOf(o);
                        if (id != null && q.ids.add(id)) q.events.add(o);
                    }
                }
            } catch (Exception e) {
                // A corrupt file starts empty: the watch resends anything not yet acked.
            }
        }
        return q;
    }

    /**
     * Returns the ids already queued or accepted into the available space. Excess events
     * stay unacknowledged so the watch can retry after the page drains the inbox.
     */
    public synchronized List<String> append(List<Object> incoming) {
        List<String> acked = new ArrayList<String>();
        boolean dirty = false;
        if (incoming != null) {
            for (Object o : incoming) {
                String id = idOf(o);
                if (id == null) continue; // malformed: skipped, never acked
                if (ids.contains(id)) {
                    acked.add(id);
                    continue;
                }
                if (events.size() >= CAP) continue;
                ids.add(id);
                events.add(o);
                acked.add(id);
                dirty = true;
            }
        }
        if (dirty) persist();
        return acked;
    }

    /** The page applied (or discarded) these: out of the queue, written back at once. */
    public synchronized void ack(List<String> ackIds) {
        if (ackIds == null || ackIds.isEmpty()) return;
        Set<String> gone = new HashSet<String>(ackIds);
        List<Object> kept = new ArrayList<Object>();
        for (Object o : events) {
            String id = idOf(o);
            if (id == null || !gone.contains(id)) kept.add(o);
        }
        if (kept.size() != events.size()) {
            events.clear();
            events.addAll(kept);
            ids.clear();
            for (Object o : events) {
                String id = idOf(o);
                if (id != null) ids.add(id);
            }
            persist();
        }
    }

    public synchronized List<Object> all() {
        return new ArrayList<Object>(events);
    }

    public synchronized int size() {
        return events.size();
    }

    private void persist() {
        try {
            storage.write(WatchJson.write(events).getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) {
            // The in-memory copy stands; the next change writes again.
        }
    }

    /** An event's id, or null when it is not a well-formed event (no object, no string id). */
    public static String idOf(Object o) {
        if (!(o instanceof Map)) return null;
        Object id = ((Map<?, ?>) o).get("id");
        return id instanceof String && !((String) id).isEmpty() ? (String) id : null;
    }
}
