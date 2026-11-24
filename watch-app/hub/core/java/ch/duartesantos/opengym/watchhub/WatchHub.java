package ch.duartesantos.opengym.watchhub;

import java.security.MessageDigest;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/**
 * The watch hub's routes — the frozen S3 contract, in one place
 * (docs/watch-v2/s3-android-hub.md is its prose). Platform-free: the Android service
 * calls handle() with its Env; the PC JVM test drives the same code over a real socket.
 *
 * Every route answers JSON and closes the connection. Every route but GET /spike (the
 * watch's transport diagnostics page, which tests reachability only and carries no data)
 * needs `Authorization: Bearer <token>` — the token the phone shows in the hub's
 * notification and the watch stores once at pairing.
 */
public final class WatchHub {

    /** The one port, chosen in S2 and kept: the watch's diagnostics page hardcodes it. */
    public static final int PORT = 8765;

    public interface Env {
        /** The pairing token; empty means no token is set and every authed route refuses. */
        String token();

        /** The latest snapshot exactly as the page sent it, or null before the first one. */
        String snapshotJson();

        /** Bumped once per stored snapshot; lets the watch skip a re-read of the same one. */
        int snapshotRev();

        /** Stores events (append-if-new by id); returns the acked ids. */
        List<String> storeEvents(List<Object> events);

        /** Events still queued on the phone (GET /watch/events, a debugging route). */
        List<Object> queuedEvents();
    }

    public static WatchHttp.Response handle(WatchHttp.Request req, Env env) {
        try {
            return route(req, env);
        } catch (WatchJson.ParseException e) {
            return err(400, "bad_json");
        } catch (Exception e) {
            return err(500, "internal");
        }
    }

    private static WatchHttp.Response route(WatchHttp.Request req, Env env) throws Exception {
        String path = req.pathOnly();
        boolean get = "GET".equals(req.method);
        boolean post = "POST".equals(req.method);

        // Diagnostics echo, the S2 spike page's target: reachability only, nothing of
        // the user's, so it alone answers without the token.
        if ("/spike".equals(path)) {
            return WatchHttp.json(200, "{\"ok\":true,\"server\":\"hub\",\"method\":\"" + esc(req.method)
                + "\",\"path\":\"" + esc(req.path)
                + "\",\"bodyLen\":" + (req.body == null ? 0 : req.body.length)
                + ",\"ua\":\"" + esc(orEmpty(req.header("User-Agent"))) + "\"}");
        }

        if (!authed(req, env)) return err(401, "unauthorized");

        if ("/watch/ping".equals(path)) {
            if (!get) return err(405, "method_not_allowed");
            // v2 supports rest events; v3 can accept the larger watch outbox
            // and leaves excess events unacknowledged when its inbox is full.
            return WatchHttp.json(200, "{\"ok\":true,\"server\":\"hub\",\"rev\":" + env.snapshotRev()
                + ",\"time\":" + System.currentTimeMillis() + ",\"proto\":3}");
        }

        if ("/watch/snapshot".equals(path)) {
            if (!get) return err(405, "method_not_allowed");
            String snap = env.snapshotJson();
            // Embedded verbatim: what the page built is what the watch parses, byte for byte.
            String body = "{\"ok\":true,\"rev\":" + env.snapshotRev()
                + ",\"snapshot\":" + (snap == null ? "null" : snap) + "}";
            return WatchHttp.json(200, body);
        }

        if ("/watch/events".equals(path)) {
            if (get) {
                StringBuilder sb = new StringBuilder("{\"ok\":true,\"queued\":");
                sb.append(WatchJson.write(env.queuedEvents()));
                sb.append('}');
                return WatchHttp.json(200, sb.toString());
            }
            if (!post) return err(405, "method_not_allowed");
            Object root = WatchJson.parse(new String(req.body, StandardCharsets.UTF_8));
            if (!(root instanceof Map)) return err(400, "bad_request");
            Object evs = ((Map<?, ?>) root).get("events");
            if (!(evs instanceof List)) return err(400, "bad_request");
            @SuppressWarnings("unchecked")
            List<String> acked = env.storeEvents((List<Object>) evs);
            StringBuilder sb = new StringBuilder("{\"ok\":true,\"acked\":");
            sb.append(WatchJson.write(acked));
            sb.append('}');
            return WatchHttp.json(200, sb.toString());
        }

        return err(404, "not_found");
    }

    /** Bearer token, compared in constant time; an unset token refuses everything. */
    private static boolean authed(WatchHttp.Request req, Env env) {
        String auth = req.header("Authorization");
        if (auth == null || !auth.startsWith("Bearer ")) return false;
        String want = env.token();
        if (want == null || want.isEmpty()) return false;
        byte[] got = auth.substring(7).trim().getBytes(StandardCharsets.UTF_8);
        return MessageDigest.isEqual(got, want.getBytes(StandardCharsets.UTF_8));
    }

    private static WatchHttp.Response err(int status, String code) {
        return WatchHttp.json(status, "{\"ok\":false,\"error\":\"" + code + "\"}");
    }

    static String orEmpty(String s) { return s == null ? "" : s; }

    static String esc(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (ch == '"' || ch == '\\') sb.append('\\').append(ch);
            else if (ch < 0x20) sb.append(String.format("\\u%04x", (int) ch));
            else sb.append(ch);
        }
        return sb.toString();
    }

    private WatchHub() { }
}
