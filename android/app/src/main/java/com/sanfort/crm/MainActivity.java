package com.sanfort.crm;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

/**
 * Sanfort CRM shell. The web app itself is served from
 * https://sanfort.sirahagents.com (see capacitor.config.json) — this class
 * only adds the native behaviour a browser tab would otherwise give us:
 *
 *  1. Downloads. The CRM generates PDFs (receipts, pending-fee statements)
 *     and Excel exports. A WebView ignores those by default, so we hand the
 *     URL to Android's DownloadManager, which saves to /Downloads and shows
 *     the usual notification. Session cookies are forwarded, otherwise the
 *     server returns the login page instead of the file.
 *  2. External links. tel:, mailto:, whatsapp:, upi: and any other host open
 *     in their real app rather than dead-ending inside our WebView.
 *  3. Back button. Handled by BridgeActivity — it walks the web history and
 *     only exits the app at the first page.
 */
public class MainActivity extends BridgeActivity {

    private static final String APP_HOST = "sanfort.sirahagents.com";

    /** Tracks the moment of the first back press, for the "press again to exit" gesture. */
    private long lastBackPress = 0L;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView webView = getBridge().getWebView();
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) ->
            startDownload(url, userAgent, contentDisposition, mimeType));

        // Back button: walk the web history first, and only leave the app when
        // there is nowhere left to go back to — and then only on a second press
        // within 2 seconds, so a stray tap never drops someone out mid-task.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView view = getBridge().getWebView();
                if (view.canGoBack()) {
                    view.goBack();
                    return;
                }
                long now = System.currentTimeMillis();
                if (now - lastBackPress < 2000) {
                    finish();
                } else {
                    lastBackPress = now;
                    Toast.makeText(MainActivity.this, "Press back again to exit", Toast.LENGTH_SHORT).show();
                }
            }
        });
    }

    /** Save a file the web app asked to download, with the session cookie attached. */
    private void startDownload(String url, String userAgent, String contentDisposition, String mimeType) {
        // Blob/data URLs are generated in-page (jsPDF) and have no server URL
        // to re-fetch; the web app opens those in a print view instead.
        if (url == null || url.startsWith("blob:") || url.startsWith("data:")) {
            Toast.makeText(this, "Use the print option to save this file", Toast.LENGTH_LONG).show();
            return;
        }
        try {
            String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setMimeType(mimeType);
            request.addRequestHeader("User-Agent", userAgent);
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null) request.addRequestHeader("Cookie", cookie);
            request.setTitle(fileName);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);

            DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager == null) throw new IllegalStateException("No DownloadManager");
            manager.enqueue(request);
            Toast.makeText(this, "Downloading " + fileName, Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "Could not download this file", Toast.LENGTH_LONG).show();
        }
    }

    /**
     * Capacitor keeps navigation inside the WebView for hosts listed in
     * `server.allowNavigation`; everything else arrives here so we can hand it
     * to the phone (dialler, mail, WhatsApp, UPI apps, Chrome).
     */
    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        Uri data = intent != null ? intent.getData() : null;
        if (data == null) return;
        String host = data.getHost();
        if (host != null && host.equalsIgnoreCase(APP_HOST)) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, data));
        } catch (Exception ignored) {
            // No app installed to handle it — stay put rather than crash.
        }
    }
}
