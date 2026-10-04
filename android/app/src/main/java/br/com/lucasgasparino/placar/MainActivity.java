package br.com.lucasgasparino.placar;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.IOException;
import java.util.Collections;
import java.util.Locale;

public final class MainActivity extends Activity {
    private static final String APP_HOST = "appassets.androidplatform.net";
    private static final String APP_URL = "https://" + APP_HOST + "/assets/www/index.html";
    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(244, 245, 241));
        getWindow().setNavigationBarColor(Color.rgb(244, 245, 241));
        int systemUiFlags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            systemUiFlags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        getWindow().getDecorView().setSystemUiVisibility(systemUiFlags);

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
        });
        setContentView(webView);
        webView.loadUrl(APP_URL);
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
