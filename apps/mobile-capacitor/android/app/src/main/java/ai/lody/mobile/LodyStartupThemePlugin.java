package ai.lody.android;

import android.webkit.WebView;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Receives the committed theme from the shared {@code ThemeProvider}
 * ({@code window.__LODY_STARTUP_THEME__.persist}), stores it for the next
 * launch, and applies it now. {@code AndroidManifest.xml} lists {@code uiMode}
 * in {@code configChanges}, so applying it does not recreate the activity or
 * reload the WebView.
 */
@CapacitorPlugin(name = "LodyStartupTheme")
public class LodyStartupThemePlugin extends Plugin {
    @PluginMethod
    public void persist(PluginCall call) {
        String raw = call.getString("theme");
        if (raw == null) {
            call.reject("theme must be one of light, dark, system");
            return;
        }
        LodyStartupTheme theme = LodyStartupTheme.fromValue(raw);
        theme.save(getContext());
        getActivity().runOnUiThread(() -> {
            theme.apply(getContext());
            WebView webView = getBridge().getWebView();
            if (webView != null) webView.setBackgroundColor(theme.backgroundColor(getContext()));
            call.resolve();
        });
    }
}
