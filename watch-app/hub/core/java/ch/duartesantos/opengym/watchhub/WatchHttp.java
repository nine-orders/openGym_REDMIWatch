package ch.duartesantos.opengym.watchhub;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * HTTP request parsing and response writing for the watch hub. No Android imports on
 * purpose: this exact code ships in the APK and also runs under the plain PC JVM
 * (watch-app/hub/javatest/WatchHubTest.java). The request shape is the one the Vela
 * watch stack sends: head up to CRLFCRLF, then a body per Content-Length, one request
 * per connection.
 */
public final class WatchHttp {
    public static final int MAX_HEAD = 16 * 1024;
    // Snapshots top out around 48 KB (the page's own fitSnapshot budget); event posts are
    // tiny. 4 MB is room for both many times over and still nothing worth abusing.
    public static final int MAX_BODY = 4 * 1024 * 1024;

    public static final class Request {
        public final String method;
        public final String path; // the raw request target, query string included
        public final Map<String, String> headers;
        public final byte[] body;

        Request(String method, String path, Map<String, String> headers, byte[] body) {
            this.method = method;
            this.path = path;
            this.headers = headers;
            this.body = body;
        }

        public String header(String name) {
            for (Map.Entry<String, String> e : headers.entrySet()) {
                if (name.equalsIgnoreCase(e.getKey())) return e.getValue();
            }
            return null;
        }

        /** The request target without its query string — what the routes match on. */
        public String pathOnly() {
            int qi = path.indexOf('?');
            return qi >= 0 ? path.substring(0, qi) : path;
        }
    }

    public static final class Response {
        public final int status;
        public final String text;
        public final byte[] body;

        public Response(int status, String text, byte[] body) {
            this.status = status;
            this.text = text;
            this.body = body;
        }
    }

    public static Response json(int status, String json) {
        return new Response(status, statusText(status), json.getBytes(StandardCharsets.UTF_8));
    }

    /**
     * A request assembled by hand rather than parsed off a socket — the S8 interconnect
     * bridge's path into the exact same routes WatchHub handles over HTTP.
     */
    public static Request request(String method, String path, Map<String, String> headers, byte[] body) {
        return new Request(method, path, headers, body == null ? new byte[0] : body);
    }

    /** One request = head up to CRLFCRLF + body per Content-Length (the watch stack always sends it). */
    public static Request parse(InputStream in) throws IOException {
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        int w0 = 0, w1 = 0, w2 = 0, w3 = 0;
        int c;
        while ((c = in.read()) != -1) {
            head.write(c);
            w0 = w1; w1 = w2; w2 = w3; w3 = c;
            if (w0 == '\r' && w1 == '\n' && w2 == '\r' && w3 == '\n') break;
            if (head.size() > MAX_HEAD) throw new IOException("request head too large");
        }
        String headStr = new String(head.toByteArray(), StandardCharsets.US_ASCII);
        String[] lines = headStr.split("\r\n");
        String[] rl = lines[0].split(" ");
        if (rl.length < 2 || rl[0].isEmpty() || rl[1].isEmpty()) {
            throw new IOException("bad request line: " + lines[0]);
        }
        Map<String, String> hs = new LinkedHashMap<String, String>();
        for (int i = 1; i < lines.length; i++) {
            int ci = lines[i].indexOf(':');
            if (ci > 0) hs.put(lines[i].substring(0, ci).trim(), lines[i].substring(ci + 1).trim());
        }
        byte[] body = new byte[0];
        String cl = hs.get("Content-Length");
        int len = 0;
        if (cl != null) {
            try { len = Integer.parseInt(cl.trim()); } catch (NumberFormatException e) { throw new IOException("bad content-length: " + cl); }
        }
        if (len < 0 || len > MAX_BODY) throw new IOException("bad body length: " + len);
        if (len > 0) {
            body = new byte[len];
            int off = 0;
            while (off < len) {
                int r = in.read(body, off, len - off);
                if (r < 0) break;
                off += r;
            }
        }
        return new Request(rl[0].toUpperCase(Locale.US), rl[1], hs, body);
    }

    public static byte[] headBytes(Response r) {
        return ("HTTP/1.1 " + r.status + " " + r.text + "\r\n"
            + "Content-Type: application/json; charset=utf-8\r\n"
            + "Content-Length: " + r.body.length + "\r\n"
            + "Connection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII);
    }

    public static String statusText(int status) {
        switch (status) {
            case 200: return "OK";
            case 400: return "Bad Request";
            case 401: return "Unauthorized";
            case 404: return "Not Found";
            case 405: return "Method Not Allowed";
            case 500: return "Internal Server Error";
            default: return "Status " + status;
        }
    }

    private WatchHttp() { }
}
