package ai.lody.android;

import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    /** Present only in builds that include the iroh bindings; absence keeps Streams RPC. */
    @SuppressWarnings("unchecked")
    private void registerIrohPlugin() {
        try {
            registerPlugin((Class<? extends com.getcapacitor.Plugin>) Class.forName("ai.lody.android.LodyIrohPlugin"));
        } catch (ClassNotFoundException ignored) {
        }
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LodyStartupThemePlugin.class);
        registerPlugin(LodyKekPlugin.class);
        registerIrohPlugin();
        // Before super.onCreate: DayNight is resolved when the activity's theme
        // is applied, and the app's committed theme has to win over the system's.
        LodyStartupTheme theme = LodyStartupTheme.load(this);
        theme.apply(this);
        super.onCreate(savedInstanceState);
        // What shows between the splash and the page's first paint. The bridge is
        // null only when Capacitor fell back to its no-WebView layout.
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView != null) webView.setBackgroundColor(theme.backgroundColor(this));
    }
}
