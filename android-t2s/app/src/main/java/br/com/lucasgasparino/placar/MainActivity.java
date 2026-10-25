package br.com.lucasgasparino.placar;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.TextView;

import java.io.IOException;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

public final class MainActivity extends Activity {
    private static final String APP_HOST = "appassets.androidplatform.net";
    private static final String APP_URL = "https://" + APP_HOST + "/assets/www/t2.html";
    private WebView webView;
    private int renderCrashes = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Placar ao vivo: a tela não apaga enquanto o app está na frente.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.rgb(244, 245, 241));
        getWindow().setNavigationBarColor(Color.rgb(244, 245, 241));
        int systemUiFlags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            systemUiFlags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        getWindow().getDecorView().setSystemUiVisibility(systemUiFlags);

        // Depuração remota do WebView só em build depurável.
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        createWebView();
    }

    /* Cria e carrega o WebView. Se o componente do sistema não abrir, mostra instruções em vez de fechar o app. */
    private boolean createWebView() {
        try {
            webView = new WebView(this);
            webView.setBackgroundColor(Color.rgb(244, 245, 241));
            WebSettings settings = webView.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setAllowFileAccess(false);
            settings.setAllowContentAccess(false);
            settings.setSupportMultipleWindows(false);

            webView.setWebViewClient(new WebViewClient() {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    Uri uri = request.getUrl();
                    if (!APP_HOST.equals(uri.getHost())) return null;
                    if (!"https".equals(uri.getScheme()) || !"GET".equals(request.getMethod())) {
                        return response(403, "Forbidden", "text/plain", "Request blocked");
                    }

                    String path = uri.getPath();
                    if (path != null && (path.startsWith("/jr/") || path.startsWith("/asc/"))) {
                        return fetchExterior(uri);
                    }
                    String assetPath = path != null && path.startsWith("/assets/")
                            ? path.substring("/assets/".length()) : "";
                    if (assetPath.isEmpty() || assetPath.contains("..") || assetPath.startsWith("/")) {
                        return response(404, "Not Found", "text/plain", "Asset not found");
                    }

                    try {
                        return new WebResourceResponse(mimeType(assetPath), "UTF-8",
                                getAssets().open(assetPath));
                    } catch (IOException exception) {
                        return response(404, "Not Found", "text/plain", "Asset not found");
                    }
                }

                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    Uri uri = request.getUrl();
                    if (APP_HOST.equals(uri.getHost())) return false;
                    String scheme = uri.getScheme();
                    if ("https".equals(scheme) || "http".equals(scheme)) {
                        try {
                            startActivity(new Intent(Intent.ACTION_VIEW, uri));
                        } catch (Exception ignored) {
                            // Keep the app open if the device has no browser for this link.
                        }
                    }
                    return true;
                }

                // Processo de renderização morreu (memória, falha do WebView): recria até 3 vezes; depois mostra o aviso.
                @Override
                public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                    if (view == webView) {
                        destroyWebView();
                        if (++renderCrashes <= 3) {
                            createWebView();
                        } else {
                            showFallback();
                        }
                    }
                    return true;
                }
            });
            setContentView(webView);
            webView.loadUrl(startUrl());
            return true;
        } catch (Throwable t) {
            destroyWebView();
            showFallback();
            return false;
        }
    }

    private void showFallback() {
        TextView text = new TextView(this);
        int pad = dp(32);
        text.setPadding(pad, pad, pad, pad);
        text.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        text.setTextColor(Color.rgb(40, 55, 60));
        text.setBackgroundColor(Color.rgb(244, 245, 241));
        text.setText("Não foi possível abrir o componente WebView do Android. Atualize o \"Android System WebView\" "
                + "(Play Store) e abra o app de novo. Enquanto isso, acompanhe em resultados.tse.jus.br.");
        setContentView(text);
    }

    private int dp(int value) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics());
    }

    private void destroyWebView() {
        if (webView == null) return;
        try {
            ViewGroup parent = (ViewGroup) webView.getParent();
            if (parent != null) parent.removeView(webView);
            webView.stopLoading();
            webView.destroy();
        } catch (Throwable ignored) {
            // o WebView pode já estar em estado inválido; descartamos mesmo assim
        }
        webView = null;
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) {
            webView.onPause();
            webView.pauseTimers();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.resumeTimers();
            webView.onResume();
        }
    }

    @Override
    protected void onDestroy() {
        destroyWebView();
        super.onDestroy();
    }

    private String startUrl() {
        try {
            ActivityInfo info = getPackageManager().getActivityInfo(
                    getComponentName(), PackageManager.GET_META_DATA);
            String page = info.metaData != null
                    ? info.metaData.getString("com.placar.START_PAGE") : null;
            if (page == null || page.isEmpty()) page = "t2.html";
            if (page.contains("..") || page.startsWith("/")) page = "t2.html";
            return "https://" + APP_HOST + "/assets/www/" + page;
        } catch (Exception ignored) {
            return APP_URL;
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    private WebResourceResponse response(int status, String reason, String mime, String body) {
        byte[] bytes = body.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        return new WebResourceResponse(mime, "UTF-8", status, reason,
                Collections.emptyMap(), new java.io.ByteArrayInputStream(bytes));
    }

    /* Proxy local da prévia do exterior: só três endereços fixos (Jornal Razão e ascaribe), nunca host/path vindo do JavaScript.
       Roda na thread de rede do WebView (shouldInterceptRequest) e o fetch do JavaScript é assíncrono: a tela não trava. */
    private WebResourceResponse fetchExterior(Uri uri) {
        String path = uri.getPath();
        String remote;
        if ("/jr/v.json".equals(path)) {
            if (!validQuery(uri, "_", false)) return response(400, "Bad Request", "text/plain", "Invalid version query");
            remote = "https://jornalrazao.com/eleicoes/d2/v.json";
        } else if ("/jr/ext.json".equals(path)) {
            if (!validQuery(uri, "v", true)) return response(400, "Bad Request", "text/plain", "Invalid data version");
            remote = "https://jornalrazao.com/eleicoes/d2/ext.json?v=" + uri.getQueryParameter("v");
        } else if ("/asc/exterior.json".equals(path)) {
            if (!validQuery(uri, "_", false)) return response(400, "Bad Request", "text/plain", "Invalid query");
            remote = "https://dados.ascaribe.tech/real/exterior.json";
        } else {
            return response(404, "Not Found", "text/plain", "Not found");
        }

        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(remote).openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(5000);
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("User-Agent", "Placar-2T-Secao/1.1.7");
            int status = connection.getResponseCode();
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            byte[] body = readLimited(stream, 2 * 1024 * 1024);
            String reason = status == 200 ? "OK" : (status == 404 ? "Not Found" : "Upstream response");
            return proxyResponse(status, reason, "application/json", body);
        } catch (Exception exception) {
            return response(502, "Bad Gateway", "text/plain", "Upstream unavailable");
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private boolean validQuery(Uri uri, String key, boolean required) {
        java.util.Set<String> names = uri.getQueryParameterNames();
        if (!required && names.isEmpty()) return true;
        if (names.size() != 1 || !names.contains(key)) return false;
        String value = uri.getQueryParameter(key);
        return value != null && value.matches("[0-9]{1,20}");
    }

    private byte[] readLimited(InputStream stream, int maxBytes) throws IOException {
        if (stream == null) return new byte[0];
        try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int read, total = 0;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > maxBytes) throw new IOException("response too large");
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        }
    }

    private WebResourceResponse proxyResponse(int status, String reason, String mime, byte[] body) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        headers.put("Access-Control-Allow-Origin", "https://" + APP_HOST);
        return new WebResourceResponse(mime, "UTF-8", status, reason, headers,
                new java.io.ByteArrayInputStream(body));
    }

    private String mimeType(String path) {
        String lower = path.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".html")) return "text/html";
        if (lower.endsWith(".js")) return "text/javascript";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".json") || lower.endsWith(".webmanifest")) return "application/json";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".ico")) return "image/x-icon";
        return "application/octet-stream";
    }
}
