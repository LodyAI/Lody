package ai.lody.android;

import android.app.UiModeManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatDelegate;

/**
 * The theme the user committed in the app, as the shell needs it before the
 * WebView has run a line of JavaScript.
 *
 * Applied in two places. {@link #apply} is called from {@code MainActivity}
 * before {@code super.onCreate} so the activity resolves DayNight against the
 * app's theme; on API 31+ it also tells the system through
 * {@link UiModeManager#setApplicationNightMode}, which persists and is what
 * makes the NEXT launch's starting window / splash come up in the app's theme
 * rather than the system's. {@link #backgroundColor} paints the WebView so
 * nothing white shows between the splash and the page's own first paint.
 */
enum LodyStartupTheme {
    LIGHT("light", AppCompatDelegate.MODE_NIGHT_NO, UiModeManager.MODE_NIGHT_NO),
    DARK("dark", AppCompatDelegate.MODE_NIGHT_YES, UiModeManager.MODE_NIGHT_YES),
    SYSTEM("system", AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM, UiModeManager.MODE_NIGHT_AUTO);

    private static final String PREFS = "lody_startup_theme";
    private static final String KEY = "theme";

    /** Tracks {@code --background} in the shared theme: Lody Light and Vesper. */
    private static final int LIGHT_BACKGROUND = Color.parseColor("#FFFFFF");
    private static final int DARK_BACKGROUND = Color.parseColor("#101010");

    final String value;
    private final int appCompatMode;
    private final int uiModeManagerMode;

    LodyStartupTheme(String value, int appCompatMode, int uiModeManagerMode) {
        this.value = value;
        this.appCompatMode = appCompatMode;
        this.uiModeManagerMode = uiModeManagerMode;
    }

    @NonNull
    static LodyStartupTheme fromValue(String raw) {
        for (LodyStartupTheme theme : values()) {
            if (theme.value.equals(raw)) return theme;
        }
        return SYSTEM;
    }

    @NonNull
    static LodyStartupTheme load(@NonNull Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return fromValue(prefs.getString(KEY, SYSTEM.value));
    }

    void save(@NonNull Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, value).apply();
    }

    void apply(@NonNull Context context) {
        AppCompatDelegate.setDefaultNightMode(appCompatMode);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            UiModeManager uiModeManager = (UiModeManager) context.getSystemService(Context.UI_MODE_SERVICE);
            if (uiModeManager != null) uiModeManager.setApplicationNightMode(uiModeManagerMode);
        }
    }

    int backgroundColor(@NonNull Context context) {
        switch (this) {
            case LIGHT:
                return LIGHT_BACKGROUND;
            case DARK:
                return DARK_BACKGROUND;
            default:
                int nightMask = context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
                return nightMask == Configuration.UI_MODE_NIGHT_YES ? DARK_BACKGROUND : LIGHT_BACKGROUND;
        }
    }
}
