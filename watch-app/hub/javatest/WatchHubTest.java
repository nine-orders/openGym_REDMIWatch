import ch.duartesantos.opengym.watchhub.WatchEventQueue;
import ch.duartesantos.opengym.watchhub.WatchHub;
import ch.duartesantos.opengym.watchhub.WatchHttp;
import ch.duartesantos.opengym.watchhub.WatchJson;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * PC JVM test of the exact hub code that ships in the APK: unit checks on the JSON
 * parser, the queue and the request parser, then the whole frozen S3 contract driven
 * over a real socket on 127.0.0.1:18766 — the curl smoke test, runnable with no phone.
 * Run from build.cmd; its exit code is the gate for the gradle build.
 */
public class WatchHubTest {
    static int fails = 0;
    static int ran = 0;

    // The env behind the socket server: the same state the phone keeps.
    static String token = "12345678";
    static String snapshotJson = null;
    static int rev = 0;
    static WatchEventQueue queue;

    public static void main(String[] args) throws Exception {
        unitJson();
        unitQueue();
        unitHttpParse();

        // ---- the contract over a real socket ----
        final ServerSocket ss = new ServerSocket();
        ss.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 18766), 8);
        Thread t = new Thread(new Runnable() {
            public void run() {
                while (true) {
                    try {
                        final Socket s = ss.accept();
                        new Thread(new Runnable() {
                            public void run() { serve(s); }
                        }).start();
                    } catch (Exception e) {
                        return;
                    }
                }
            }
        });
        t.setDaemon(true);
        t.start();
        String base = "http://127.0.0.1:18766";
        String auth = "Bearer " + token;

        // GET /spike, no token: the diagnostics echo, auth-exempt by design
        Res r = req("GET", base + "/spike", null, null);
        check("spike echo without token", r.code == 200 && r.body.contains("\"ok\":true")
            && r.body.contains("\"server\":\"hub\"") && r.body.contains("\"method\":\"GET\""), r);

        // every /watch route refuses without the token
        r = req("GET", base + "/watch/ping", null, null);
        check("ping without token -> 401", r.code == 401 && r.body.contains("\"error\":\"unauthorized\""), r);
        r = req("GET", base + "/watch/snapshot", null, null);
        check("snapshot without token -> 401", r.code == 401, r);
        r = req("GET", base + "/watch/ping", null, "Basic " + token);
        check("wrong scheme -> 401", r.code == 401, r);
        r = req("GET", base + "/watch/ping", null, "Bearer 87654321");
        check("wrong token -> 401", r.code == 401, r);

        // ping with the token
        r = req("GET", base + "/watch/ping", null, auth);
        check("ping with token", r.code == 200 && r.body.contains("\"ok\":true")
            && r.body.contains("\"server\":\"hub\"") && r.body.contains("\"time\":1"), r);
        // protocol version (v2.1, s9): the watch's capability negotiation reads this field
        r = req("GET", base + "/watch/ping", null, auth);
        check("ping carries proto", r.body.contains("\"proto\":2"), r);

        // snapshot before the page ever sent one: ok, rev 0, snapshot null
        r = req("GET", base + "/watch/snapshot", null, auth);
        check("snapshot before first send", r.code == 200
            && r.body.equals("{\"ok\":true,\"rev\":0,\"snapshot\":null}"), r);

        // a query string changes nothing
        r = req("GET", base + "/watch/snapshot?x=1", null, auth);
        check("snapshot ignores query", r.code == 200 && r.body.contains("\"snapshot\":null"), r);

        // the page sends a snapshot: served verbatim, rev bumped
        String snap = "{\"v\":1,\"unit\":\"kg\",\"active\":null,\"ready\":null}";
        snapshotJson = snap;
        rev = 1;
        r = req("GET", base + "/watch/snapshot", null, auth);
        check("snapshot served verbatim", r.code == 200
            && r.body.equals("{\"ok\":true,\"rev\":1,\"snapshot\":" + snap + "}"), r);

        // events: two well-formed arrive, both acked, queued on the phone
        queue = WatchEventQueue.load(new MemStorage());
        String ev1 = "{\"id\":\"e1\",\"type\":\"setDone\",\"wid\":\"w1\",\"exId\":\"bench\",\"entryIdx\":0,\"setIdx\":0,\"w\":60,\"r\":8,\"at\":1761984000000}";
        String ev2 = "{\"id\":\"e2\",\"type\":\"start\",\"routineIds\":[\"r1\"],\"wid\":\"w2\",\"at\":1761984001000}";
        r = req("POST", base + "/watch/events", "{\"events\":[" + ev1 + "," + ev2 + "]}", auth);
        check("events POST acked", r.code == 200 && r.body.equals("{\"ok\":true,\"acked\":[\"e1\",\"e2\"]}"), r);
        check("events queued", queue.size() == 2, "size=" + queue.size());

        // a resend of e1 (response lost in transit) plus a new e3: e1 acked again, stored once
        String ev3 = "{\"id\":\"e3\",\"type\":\"setDone\",\"wid\":\"w1\",\"exId\":\"bench\",\"entryIdx\":0,\"setIdx\":1,\"w\":62.5,\"r\":6,\"at\":1761984002000}";
        r = req("POST", base + "/watch/events", "{\"events\":[" + ev1 + "," + ev3 + "]}", auth);
        check("resend deduped", r.code == 200 && r.body.equals("{\"ok\":true,\"acked\":[\"e1\",\"e3\"]}"), r);
        check("queue holds 3", queue.size() == 3, "size=" + queue.size());
        check("62.5 kept as double", WatchJson.write(queue.all().get(2)).contains("62.5"), WatchJson.write(queue.all().get(2)));

        // a malformed event rides along, is skipped and never acked
        r = req("POST", base + "/watch/events", "{\"events\":[{\"noId\":1},{\"id\":\"e4\",\"type\":\"finish\",\"wid\":\"w2\"}]}", auth);
        check("malformed skipped", r.code == 200 && r.body.equals("{\"ok\":true,\"acked\":[\"e4\"]}"), r);
        check("queue holds 4", queue.size() == 4, "size=" + queue.size());

        // the debugging route lists what is queued
        r = req("GET", base + "/watch/events", null, auth);
        check("GET events lists queue", r.code == 200 && r.body.contains("\"id\":\"e1\"")
            && r.body.contains("\"id\":\"e4\"") && r.body.contains("\"w\":62.5"), r);

        // bad bodies
        r = req("POST", base + "/watch/events", "{not json", auth);
        check("bad json -> 400 bad_json", r.code == 400 && r.body.contains("\"error\":\"bad_json\""), r);
        r = req("POST", base + "/watch/events", "[1,2]", auth);
        check("array body -> 400 bad_request", r.code == 400 && r.body.contains("\"error\":\"bad_request\""), r);
        r = req("POST", base + "/watch/events", "{\"nope\":1}", auth);
        check("no events key -> 400 bad_request", r.code == 400 && r.body.contains("\"error\":\"bad_request\""), r);

        // unknown path and wrong method
        r = req("GET", base + "/watch/nope", null, auth);
        check("unknown -> 404", r.code == 404 && r.body.contains("\"error\":\"not_found\""), r);
        r = req("POST", base + "/watch/snapshot", "{}", auth);
        check("POST snapshot -> 405", r.code == 405 && r.body.contains("\"error\":\"method_not_allowed\""), r);
        r = req("DELETE", base + "/watch/events", null, auth);
        check("DELETE events -> 405", r.code == 405, r);
        r = req("GET", base + "/spike", null, null);
        check("spike survives others", r.code == 200, r);

        // the exact status line and headers on the wire
        String raw = rawGet(base + "/watch/ping", auth);
        check("wire head", raw.startsWith("HTTP/1.1 200 OK\r\n")
            && raw.contains("Content-Type: application/json; charset=utf-8\r\n")
            && raw.contains("Connection: close\r\n\r\n"), raw);

        if (fails == 0) {
            System.out.println("WatchHubTest PASS (" + ran + " checks)");
        } else {
            System.out.println("WatchHubTest FAIL: " + fails + " failing check(s) of " + ran);
            System.exit(1);
        }
    }

    /* ---------- units ---------- */

    static void unitJson() throws Exception {
        Map<String, Object> o = new LinkedHashMap<String, Object>();
        o.put("n", 42L);
        o.put("f", 1.5);
        o.put("s", "a\"b\\c\n\u4f60");
        o.put("t", Boolean.TRUE);
        o.put("z", null);
        List<Object> l = new ArrayList<Object>(Arrays.asList(new Object[] { 1L, "x" }));
        o.put("l", l);
        String j = WatchJson.write(o);
        // Non-ASCII rides raw: the response is UTF-8 on the wire, and JSON allows it.
        check("json write", j.equals("{\"n\":42,\"f\":1.5,\"s\":\"a\\\"b\\\\c\\n你\",\"t\":true,\"z\":null,\"l\":[1,\"x\"]}"), j);
        Object back = WatchJson.parse(j);
        check("json round trip", WatchJson.write(back).equals(j), WatchJson.write(back));

        check("json big int", Long.valueOf(1761984000000L).equals(WatchJson.parse("1761984000000")), "at");
        check("json integral double -> long", WatchJson.parse("1.7E12").equals(Long.valueOf(1700000000000L)),
            String.valueOf(WatchJson.parse("1.7E12")));
        check("json true/false/null", WatchJson.parse("[true,false,null]").equals(Arrays.asList(Boolean.TRUE, Boolean.FALSE, null)), "?");
        check("json exponent", WatchJson.parse("1.5e-3").equals(Double.valueOf(0.0015)), "?");
        check("json whitespace", WatchJson.parse("  { \"a\" : [ 1 , 2 ] } ").toString().contains("1"), "?");
        check("json empty", WatchJson.parse("{}").toString().equals("{}") && WatchJson.parse("[]").toString().equals("[]"), "?");
        check("json slash escape", WatchJson.parse("\"a\\/b\"").equals("a/b"), "?");
        try { WatchJson.parse("{\"a\":}"); fail("json trailing garbage caught"); }
        catch (WatchJson.ParseException e) { ok("json trailing garbage caught"); }
        try { WatchJson.parse("[1,]"); fail("json trailing comma caught"); }
        catch (WatchJson.ParseException e) { ok("json trailing comma caught"); }
        try { WatchJson.parse("12 34"); fail("json two numbers caught"); }
        catch (WatchJson.ParseException e) { ok("json two numbers caught"); }
        try { WatchJson.parse("unterminated"); fail("json bad literal caught"); }
        catch (WatchJson.ParseException e) { ok("json bad literal caught"); }
        try { WatchJson.parse("\"\\u12g4\""); fail("json bad u-escape caught"); }
        catch (WatchJson.ParseException e) { ok("json bad u-escape caught"); }
    }

    /** In-memory Storage for the queue tests. */
    static final class MemStorage implements WatchEventQueue.Storage {
        byte[] data;

        public byte[] read() { return data; }

        public void write(byte[] d) { data = d; }
    }

    static void unitQueue() throws Exception {
        MemStorage st = new MemStorage();
        WatchEventQueue q = WatchEventQueue.load(st);
        check("queue empty on fresh storage", q.size() == 0, "?");

        Map<String, Object> a = ev("a"), b = ev("b");
        List<Object> in = new ArrayList<Object>(Arrays.asList(new Object[] { a, b, "junk", null, ev(null) }));
        List<String> acked = q.append(in);
        check("queue acked well-formed only", acked.equals(Arrays.asList("a", "b")) && q.size() == 2, acked.toString());
        check("queue persisted", st.data != null && new String(st.data, StandardCharsets.UTF_8).contains("\"a\""), "?");

        WatchEventQueue q2 = WatchEventQueue.load(st);
        check("queue reloads from storage", q2.size() == 2, "size=" + q2.size());
        check("queue reload dedupes", q2.append(Arrays.asList((Object) a)).equals(Arrays.asList("a")) && q2.size() == 2, "?");

        q2.ack(Arrays.asList("a"));
        check("queue ack removes", q2.size() == 1 && WatchJson.write(q2.all()).contains("\"b\""), "?");
        check("queue ack persisted", !new String(st.data, StandardCharsets.UTF_8).contains("\"a\""), "?");
        q2.ack(Arrays.asList("zz"));
        check("queue ack unknown no-op", q2.size() == 1, "?");

        // corrupt storage starts empty
        MemStorage bad = new MemStorage();
        bad.data = "{oops".getBytes(StandardCharsets.UTF_8);
        check("queue corrupt storage -> empty", WatchEventQueue.load(bad).size() == 0, "?");

        // cap: oldest first out
        MemStorage cap = new MemStorage();
        WatchEventQueue qc = WatchEventQueue.load(cap);
        List<Object> many = new ArrayList<Object>();
        for (int i = 0; i < 505; i++) many.add(ev("n" + i));
        qc.append(many);
        List<Object> all = qc.all();
        check("queue capped at 500", all.size() == 500 && "n5".equals(WatchEventQueue.idOf(all.get(0)))
            && "n504".equals(WatchEventQueue.idOf(all.get(499))), "first=" + WatchEventQueue.idOf(all.get(0)));
    }

    static Map<String, Object> ev(String id) {
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        if (id != null) m.put("id", id);
        m.put("type", "setDone");
        return m;
    }

    static void unitHttpParse() throws Exception {
        String head = "POST /watch/events?x=1 HTTP/1.1\r\nHost: p\r\nContent-Length: 5\r\nAuthorization: Bearer 12345678\r\n\r\n";
        byte[] bodyBytes = "hello".getBytes(StandardCharsets.US_ASCII);
        java.io.ByteArrayInputStream in = new java.io.ByteArrayInputStream(
            concat(head.getBytes(StandardCharsets.US_ASCII), bodyBytes));
        WatchHttp.Request r = WatchHttp.parse(in);
        check("http parse method/path", "POST".equals(r.method) && "/watch/events?x=1".equals(r.path), r.path);
        check("http parse pathOnly", "/watch/events".equals(r.pathOnly()), r.pathOnly());
        check("http parse header", "Bearer 12345678".equals(r.header("authorization")), "?");
        check("http parse body", "hello".equals(new String(r.body, StandardCharsets.US_ASCII)), "?");
    }

    static byte[] concat(byte[] a, byte[] b) {
        byte[] out = new byte[a.length + b.length];
        System.arraycopy(a, 0, out, 0, a.length);
        System.arraycopy(b, 0, out, a.length, b.length);
        return out;
    }

    /* ---------- the socket server (the hub's serve loop, as the service runs it) ---------- */

    static void serve(Socket s) {
        try {
            s.setSoTimeout(5000);
            InputStream in = new BufferedInputStream(s.getInputStream());
            OutputStream out = new BufferedOutputStream(s.getOutputStream());
            WatchHttp.Request req = WatchHttp.parse(in);
            WatchHttp.Response res = WatchHub.handle(req, new WatchHub.Env() {
                public String token() { return token; }
                public String snapshotJson() { return snapshotJson; }
                public int snapshotRev() { return rev; }
                public List<String> storeEvents(List<Object> events) { return queue.append(events); }
                public List<Object> queuedEvents() { return queue.all(); }
            });
            out.write(WatchHttp.headBytes(res));
            out.write(res.body);
            out.flush();
        } catch (Exception e) {
            System.out.println("  serve error: " + e);
            fails++;
        } finally {
            try { s.close(); } catch (Exception ignored) { }
        }
    }

    /* ---------- the client ---------- */

    static final class Res {
        final int code;
        final String body;

        Res(int code, String body) {
            this.code = code;
            this.body = body;
        }
    }

    static Res req(String method, String url, String body, String auth) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(3000);
        c.setReadTimeout(3000);
        if (auth != null) c.setRequestProperty("Authorization", auth);
        if (body != null) {
            c.setDoOutput(true);
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            c.setFixedLengthStreamingMode(bytes.length);
            OutputStream out = c.getOutputStream();
            out.write(bytes);
            out.flush();
            out.close();
        }
        int code = c.getResponseCode();
        InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        StringBuilder sb = new StringBuilder();
        if (in != null) {
            int ch;
            while ((ch = in.read()) != -1) sb.append((char) ch);
            in.close();
        }
        return new Res(code, sb.toString());
    }

    /** The first bytes of the response, status line and headers included. */
    static String rawGet(String url, String auth) throws Exception {
        Socket s = new Socket(InetAddress.getByName("127.0.0.1"), 18766);
        try {
            s.setSoTimeout(3000);
            OutputStream out = s.getOutputStream();
            out.write(("GET /watch/ping HTTP/1.1\r\nHost: p\r\nAuthorization: " + auth + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            out.flush();
            InputStream in = new BufferedInputStream(s.getInputStream());
            StringBuilder sb = new StringBuilder();
            int ch, guard = 0;
            while (guard++ < 4096 && (ch = in.read()) != -1) {
                sb.append((char) ch);
                if (sb.length() > 24 && sb.substring(sb.length() - 4).equals("\r\n\r\n")) break;
            }
            return sb.toString();
        } finally {
            s.close();
        }
    }

    static void check(String name, boolean good, Object evidence) {
        ran++;
        if (good) System.out.println("  ok  " + name);
        else {
            fails++;
            System.out.println("  FAIL " + name + "  <- " + evidence);
        }
    }

    static void ok(String name) { check(name, true, ""); }

    static void fail(String name) { check(name, false, "expected an exception"); }
}
