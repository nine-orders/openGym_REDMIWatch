package ch.duartesantos.opengym.watchhub;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal JSON for the watch hub: parse into Map / List / String / Long / Double /
 * Boolean / null, and write those back. No Android imports on purpose — this exact
 * code ships in the APK and also runs under the plain PC JVM
 * (watch-app/hub/javatest/WatchHubTest.java), so the wire behaviour is tested on the
 * build machine before anyone touches a phone.
 *
 * Integral numbers come back as Long and write without a decimal point; a double that
 * is whole and safely integral writes the same way, so 1.7E12 never appears on the wire.
 * The snapshot is never parsed at all — it is embedded verbatim — so round-trip
 * formatting only ever matters for events, where value equality is what counts.
 */
public final class WatchJson {

    public static final class ParseException extends Exception {
        ParseException(String msg) { super(msg); }
    }

    public static Object parse(String s) throws ParseException {
        if (s == null) throw new ParseException("null input");
        P p = new P(s);
        p.ws();
        Object v = p.value();
        p.ws();
        if (p.i < s.length()) throw new ParseException("trailing characters at " + p.i);
        return v;
    }

    private static final class P {
        final String s;
        int i;

        P(String s) { this.s = s; }

        void ws() {
            while (i < s.length()) {
                char c = s.charAt(i);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') i++;
                else break;
            }
        }

        char peek() throws ParseException {
            if (i >= s.length()) throw new ParseException("unexpected end of input");
            return s.charAt(i);
        }

        Object value() throws ParseException {
            char c = peek();
            switch (c) {
                case '{': return object();
                case '[': return array();
                case '"': return string();
                case 't': expect("true"); return Boolean.TRUE;
                case 'f': expect("false"); return Boolean.FALSE;
                case 'n': expect("null"); return null;
                default: return number();
            }
        }

        void expect(String word) throws ParseException {
            if (!s.startsWith(word, i)) throw new ParseException("bad literal at " + i);
            i += word.length();
        }

        Map<String, Object> object() throws ParseException {
            i++; // {
            Map<String, Object> m = new LinkedHashMap<String, Object>();
            ws();
            if (peek() == '}') { i++; return m; }
            while (true) {
                ws();
                if (peek() != '"') throw new ParseException("expected a key at " + i);
                String k = string();
                ws();
                if (peek() != ':') throw new ParseException("expected ':' at " + i);
                i++;
                ws();
                m.put(k, value());
                ws();
                char c = peek();
                if (c == ',') { i++; continue; }
                if (c == '}') { i++; return m; }
                throw new ParseException("expected ',' or '}' at " + i);
            }
        }

        List<Object> array() throws ParseException {
            i++; // [
            List<Object> l = new ArrayList<Object>();
            ws();
            if (peek() == ']') { i++; return l; }
            while (true) {
                ws();
                l.add(value());
                ws();
                char c = peek();
                if (c == ',') { i++; continue; }
                if (c == ']') { i++; return l; }
                throw new ParseException("expected ',' or ']' at " + i);
            }
        }

        String string() throws ParseException {
            i++; // opening quote
            StringBuilder sb = new StringBuilder();
            while (true) {
                if (i >= s.length()) throw new ParseException("unterminated string");
                char c = s.charAt(i++);
                if (c == '"') return sb.toString();
                if (c != '\\') { sb.append(c); continue; }
                if (i >= s.length()) throw new ParseException("unterminated escape");
                char e = s.charAt(i++);
                switch (e) {
                    case '"': sb.append('"'); break;
                    case '\\': sb.append('\\'); break;
                    case '/': sb.append('/'); break;
                    case 'b': sb.append('\b'); break;
                    case 'f': sb.append('\f'); break;
                    case 'n': sb.append('\n'); break;
                    case 'r': sb.append('\r'); break;
                    case 't': sb.append('\t'); break;
                    case 'u':
                        if (i + 4 > s.length()) throw new ParseException("bad \\u escape");
                        try { sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); }
                        catch (NumberFormatException nfe) { throw new ParseException("bad \\u escape at " + i); }
                        i += 4;
                        break;
                    default: throw new ParseException("bad escape \\" + e);
                }
            }
        }

        Object number() throws ParseException {
            int start = i;
            if (i < s.length() && s.charAt(i) == '-') i++;
            while (i < s.length()) {
                char c = s.charAt(i);
                if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') i++;
                else break;
            }
            String tok = s.substring(start, i);
            if (tok.isEmpty() || tok.equals("-")) throw new ParseException("bad number at " + start);
            try {
                if (tok.indexOf('.') < 0 && tok.indexOf('e') < 0 && tok.indexOf('E') < 0) return Long.parseLong(tok);
                double d = Double.parseDouble(tok);
                if (d == Math.rint(d) && !Double.isInfinite(d) && Math.abs(d) < 9.007199254740992E15) return (long) d;
                return d;
            } catch (NumberFormatException e) {
                throw new ParseException("bad number: " + tok);
            }
        }
    }

    public static String write(Object v) {
        StringBuilder sb = new StringBuilder();
        writeTo(sb, v);
        return sb.toString();
    }

    private static void writeTo(StringBuilder sb, Object v) {
        if (v == null) { sb.append("null"); return; }
        if (v instanceof String) { writeString(sb, (String) v); return; }
        if (v instanceof Boolean) { sb.append(((Boolean) v).booleanValue() ? "true" : "false"); return; }
        if (v instanceof Double) {
            double d = ((Double) v).doubleValue();
            if (d == Math.rint(d) && !Double.isInfinite(d) && Math.abs(d) < 9.007199254740992E15) {
                sb.append((long) d);
            } else if (Double.isNaN(d) || Double.isInfinite(d)) {
                throw new IllegalArgumentException("cannot write " + d);
            } else {
                sb.append(Double.toString(d));
            }
            return;
        }
        if (v instanceof Number) { sb.append(v.toString()); return; }
        if (v instanceof Map) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                if (!first) sb.append(',');
                first = false;
                writeString(sb, String.valueOf(e.getKey()));
                sb.append(':');
                writeTo(sb, e.getValue());
            }
            sb.append('}');
            return;
        }
        if (v instanceof List) {
            sb.append('[');
            boolean first = true;
            for (Object o : (List<?>) v) {
                if (!first) sb.append(',');
                first = false;
                writeTo(sb, o);
            }
            sb.append(']');
            return;
        }
        throw new IllegalArgumentException("cannot write: " + v.getClass().getName());
    }

    private static void writeString(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        sb.append('"');
    }

    private WatchJson() { }
}
