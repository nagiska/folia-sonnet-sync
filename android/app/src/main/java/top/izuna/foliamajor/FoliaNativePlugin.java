package top.izuna.foliamajor;

import android.util.Base64;
import android.webkit.CookieManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 内置 Folia Bridge 需要的两件原生能力：WebView 的 cookie 罐，以及绕开 CORS 的 HTTP 请求。
 *
 * 页面里的 src/nativeBridge/api 那套 JS（网易云 / QQ / 酷狗 / 波点）不自己开网络，它把请求
 * 交给 src/services/nativeAndroidBridge.ts，后者再调这里的 httpRequest；Cookie 也走这里，
 * 读写的是 WebView 自己的 CookieManager，所以登录态在页面刷新后还在。
 */
@CapacitorPlugin(name = "FoliaNative")
public class FoliaNativePlugin extends Plugin {

    private static final int DEFAULT_CONNECT_TIMEOUT_MS = 20000;
    private static final int DEFAULT_READ_TIMEOUT_MS = 45000;

    @PluginMethod
    public void cookiesGetAll(PluginCall call) {
        String url = call.getString("url", "");
        String domain = call.getString("domain", "");
        if (url == null || url.isEmpty()) {
            if (domain == null || domain.isEmpty()) {
                url = "https://localhost/";
            } else {
                url = domain.startsWith("http") ? domain : "https://" + domain;
            }
        }
        JSArray cookies = new JSArray();
        for (JSObject cookie : parseCookieHeader(CookieManager.getInstance().getCookie(url))) {
            cookies.put(cookie);
        }
        JSObject result = new JSObject();
        result.put("cookies", cookies);
        call.resolve(result);
    }

    @PluginMethod
    public void cookiesGet(PluginCall call) {
        String url = call.getString("url", "https://localhost/");
        String name = call.getString("name", "");
        if (name == null || name.isEmpty()) {
            call.reject("Missing cookie name");
            return;
        }
        for (JSObject cookie : parseCookieHeader(CookieManager.getInstance().getCookie(url))) {
            if (name.equals(cookie.optString("name"))) {
                JSObject result = new JSObject();
                result.put("cookie", cookie);
                call.resolve(result);
                return;
            }
        }
        JSObject result = new JSObject();
        result.put("cookie", null);
        call.resolve(result);
    }

    @PluginMethod
    public void cookiesSet(PluginCall call) {
        String url = call.getString("url", "");
        String name = call.getString("name", "");
        String value = call.getString("value", "");
        if (url == null || url.isEmpty() || name == null || name.isEmpty()) {
            call.reject("Cookie url and name are required");
            return;
        }
        StringBuilder cookie = new StringBuilder();
        cookie.append(name).append('=').append(value == null ? "" : value);
        String domain = call.getString("domain", "");
        String path = call.getString("path", "/");
        if (domain != null && !domain.isEmpty()) cookie.append("; domain=").append(domain);
        if (path != null && !path.isEmpty()) cookie.append("; path=").append(path);
        if (Boolean.TRUE.equals(call.getBoolean("secure", false))) cookie.append("; Secure");
        Double expirationDate = call.getDouble("expirationDate");
        if (expirationDate != null) {
            cookie.append("; Max-Age=").append((int) Math.max(0, expirationDate - System.currentTimeMillis() / 1000.0));
        }
        CookieManager.getInstance().setCookie(url, cookie.toString());
        CookieManager.getInstance().flush();
        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }

    @PluginMethod
    public void cookiesRemove(PluginCall call) {
        String url = call.getString("url", "");
        String name = call.getString("name", "");
        if (url == null || url.isEmpty() || name == null || name.isEmpty()) {
            call.reject("Cookie url and name are required");
            return;
        }
        CookieManager.getInstance().setCookie(url, name + "=; Max-Age=0; path=/");
        CookieManager.getInstance().flush();
        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }

    @PluginMethod
    public void cookiesRemoveBatch(PluginCall call) {
        JSArray entries = call.getArray("entries");
        if (entries == null || entries.length() == 0) {
            JSObject empty = new JSObject();
            empty.put("ok", true);
            empty.put("removed", 0);
            call.resolve(empty);
            return;
        }
        CookieManager manager = CookieManager.getInstance();
        int removed = 0;
        for (int index = 0; index < entries.length(); index++) {
            JSONObject entry = entries.optJSONObject(index);
            if (entry == null) continue;
            String url = entry.optString("url", "");
            String name = entry.optString("name", "");
            if (url == null || url.isEmpty() || name == null || name.isEmpty()) continue;
            manager.setCookie(url, name + "=; Max-Age=0; path=/");
            removed++;
        }
        if (removed > 0) manager.flush();
        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("removed", removed);
        call.resolve(result);
    }

    @PluginMethod
    public void httpRequest(PluginCall call) {
        String url = call.getString("url", "");
        String method = call.getString("method", "GET");
        String bodyText = call.getString("bodyText", "");
        String bodyBase64 = call.getString("bodyBase64", "");
        String redirect = call.getString("redirect", "follow");
        if (url == null || url.isEmpty()) {
            call.reject("Missing request url");
            return;
        }
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            String requestMethod = method == null || method.isEmpty() ? "GET" : method.toUpperCase(Locale.ROOT);
            connection.setRequestMethod(requestMethod);
            connection.setConnectTimeout(DEFAULT_CONNECT_TIMEOUT_MS);
            Integer timeoutMs = call.getInt("timeoutMs");
            connection.setReadTimeout(timeoutMs != null && timeoutMs > 0 ? timeoutMs : DEFAULT_READ_TIMEOUT_MS);
            connection.setInstanceFollowRedirects(!"manual".equals(redirect));

            boolean hasCookieHeader = false;
            JSObject headers = call.getObject("headers");
            if (headers != null) {
                java.util.Iterator<String> names = headers.keys();
                while (names.hasNext()) {
                    String headerName = names.next();
                    Object headerValue = headers.opt(headerName);
                    if (headerValue == null) continue;
                    if ("cookie".equalsIgnoreCase(headerName)) hasCookieHeader = true;
                    connection.setRequestProperty(headerName, String.valueOf(headerValue));
                }
            }
            // OkHttp 不共用 WebView 的 cookie 罐，这里手动带上，登录态才能跟着请求走。
            if (!hasCookieHeader) {
                String storedCookies = CookieManager.getInstance().getCookie(url);
                if (storedCookies != null && !storedCookies.isEmpty()) {
                    connection.setRequestProperty("Cookie", storedCookies);
                }
            }

            byte[] payload = null;
            if (bodyBase64 != null && !bodyBase64.isEmpty()) {
                payload = Base64.decode(bodyBase64, Base64.DEFAULT);
            } else if (bodyText != null && !bodyText.isEmpty()) {
                payload = bodyText.getBytes(java.nio.charset.StandardCharsets.UTF_8);
            }
            if (payload != null || requiresRequestBody(requestMethod)) {
                if (payload == null) payload = new byte[0];
                connection.setDoOutput(true);
                if (connection.getRequestProperty("Content-Type") == null) {
                    connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                }
                connection.setFixedLengthStreamingMode(payload.length);
                try (OutputStream out = connection.getOutputStream()) {
                    out.write(payload);
                }
            }

            int status = connection.getResponseCode();
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            byte[] body = stream == null ? new byte[0] : readAll(stream);

            JSArray responseHeaders = new JSArray();
            for (Map.Entry<String, List<String>> entry : connection.getHeaderFields().entrySet()) {
                if (entry.getKey() == null) continue;
                for (String value : entry.getValue()) {
                    JSObject headerEntry = new JSObject();
                    headerEntry.put("name", entry.getKey());
                    headerEntry.put("value", value);
                    responseHeaders.put(headerEntry);
                }
            }
            storeResponseCookies(url, connection.getHeaderFields().get("Set-Cookie"));

            JSObject result = new JSObject();
            result.put("status", status);
            result.put("headers", responseHeaders);
            result.put("bodyBase64", Base64.encodeToString(body, Base64.NO_WRAP));
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage() == null ? "Request failed" : error.getMessage(), error);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static byte[] readAll(InputStream stream) throws Exception {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int read;
        while ((read = stream.read(chunk)) != -1) {
            buffer.write(chunk, 0, read);
        }
        return buffer.toByteArray();
    }

    private static boolean requiresRequestBody(String method) {
        if (method == null) return false;
        return "POST".equalsIgnoreCase(method)
            || "PUT".equalsIgnoreCase(method)
            || "PATCH".equalsIgnoreCase(method)
            || "PROPPATCH".equalsIgnoreCase(method)
            || "REPORT".equalsIgnoreCase(method);
    }

    private void storeResponseCookies(String requestUrl, List<String> setCookies) {
        if (setCookies == null || setCookies.isEmpty()) return;
        CookieManager manager = CookieManager.getInstance();
        boolean changed = false;
        for (String rawCookie : setCookies) {
            String cookie = normalizeCookieForUrl(rawCookie);
            if (cookie == null || cookie.isEmpty()) continue;
            manager.setCookie(requestUrl, cookie);
            changed = true;
        }
        if (changed) manager.flush();
    }

    private static String normalizeCookieForUrl(String rawCookie) {
        if (rawCookie == null || rawCookie.isEmpty()) return null;
        for (String attribute : rawCookie.split(";")) {
            if (attribute.trim().toLowerCase(Locale.ROOT).startsWith("path=")) return rawCookie;
        }
        return rawCookie + "; Path=/";
    }

    private List<JSObject> parseCookieHeader(String header) {
        List<JSObject> cookies = new ArrayList<>();
        if (header == null || header.isEmpty()) return cookies;
        Map<String, String> attributes = new LinkedHashMap<>();
        for (String pair : header.split(";")) {
            int equals = pair.indexOf('=');
            if (equals <= 0) continue;
            attributes.put(pair.substring(0, equals).trim(), pair.substring(equals + 1).trim());
        }
        for (Map.Entry<String, String> entry : attributes.entrySet()) {
            JSObject cookie = new JSObject();
            cookie.put("name", entry.getKey());
            cookie.put("value", entry.getValue());
            cookie.put("domain", "");
            cookie.put("path", "/");
            cookies.add(cookie);
        }
        return cookies;
    }
}
