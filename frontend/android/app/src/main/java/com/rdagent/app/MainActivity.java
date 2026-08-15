package com.rdagent.app;

import android.app.DownloadManager;
import android.content.Context;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.CookieManager;
import android.webkit.URLUtil;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // The WebView has no download support by default, so the report PDF
        // export would silently fail on Android. Forward any attachment download
        // (for example /api/reports/export?format=pdf) to the system Download
        // Manager, carrying the session cookie so the authenticated export works.
        getBridge().getWebView().setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> {
            try {
                String cookie = CookieManager.getInstance().getCookie(url);
                String fileName = URLUtil.guessFileName(url, contentDisposition, mimetype);
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                if (cookie != null) {
                    request.addRequestHeader("Cookie", cookie);
                }
                request.setMimeType(mimetype);
                request.setTitle(fileName);
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
                DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                manager.enqueue(request);
            } catch (Exception ignored) {
            }
        });

        // Handle Android back gesture/button using the modern OnBackPressedCallback API
        // (replaces deprecated onBackPressed() to fix API-33+ deprecation error).
        // We ask the JS layer if it can handle the back action first. If the JS
        // returns false (user is on the Dashboard with nothing open) we finish()
        // the Activity ourselves to close the app cleanly.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (getBridge() != null && getBridge().getWebView() != null) {
                    getBridge().getWebView().evaluateJavascript(
                        "(function(){ return (window.handleAndroidBack && window.handleAndroidBack()) ? 'true' : 'false'; })()",
                        value -> {
                            if ("\"false\"".equals(value) || "false".equals(value)) {
                                runOnUiThread(MainActivity.this::finish);
                            }
                        }
                    );
                } else {
                    finish();
                }
            }
        });
    }

    @Override
    public void onStop() {
        super.onStop();
        CookieManager.getInstance().flush();
    }
}
