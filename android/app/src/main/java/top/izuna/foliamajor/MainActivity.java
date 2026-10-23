package top.izuna.foliamajor;

import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.Window;
import android.view.WindowManager;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

// 统一管理 Android 窗口规则，避免内置插件覆盖全面屏与双栏外观。
public class MainActivity extends BridgeActivity {
    private FoliaWindowInsets windowInsets;
    private boolean immersive;
    private boolean isDaylight;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        isDaylight = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
            != Configuration.UI_MODE_NIGHT_YES;
        registerPlugin(FoliaWindowPlugin.class);
        registerPlugin(FoliaMediaSessionPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void load() {
        super.load();
        if (bridge == null || bridge.getWebView() == null) {
            return;
        }
        windowInsets = new FoliaWindowInsets(bridge.getWebView());
        windowInsets.install(bridge);
        applyWindowRules();
        // 排在内置插件初始化的 UI 任务之后，确保最终窗口状态由本应用决定。
        getWindow().getDecorView().post(this::applyWindowRules);
    }

    void configureWindow(boolean immersive, boolean isDaylight) {
        this.immersive = immersive;
        this.isDaylight = isDaylight;
        applyWindowRules();
    }

    // 只在配置和生命周期变化时恢复双栏，保留用户滑出的瞬时系统栏。
    @SuppressWarnings("deprecation")
    private void applyWindowRules() {
        if (windowInsets == null || isFinishing() || isDestroyed()) {
            return;
        }
        Window window = getWindow();
        WindowCompat.setDecorFitsSystemWindows(window, false);
        window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS
            | WindowManager.LayoutParams.FLAG_TRANSLUCENT_NAVIGATION);
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        window.setStatusBarColor(Color.TRANSPARENT);
        // Android 7 没有深色导航图标，只在导航栏范围加暗底保证白色图标可读。
        window.setNavigationBarColor(Build.VERSION.SDK_INT < Build.VERSION_CODES.O && isDaylight
            ? 0x99000000 : Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.setNavigationBarDividerColor(Color.TRANSPARENT);
            WindowManager.LayoutParams attributes = window.getAttributes();
            int cutoutMode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            if (attributes.layoutInDisplayCutoutMode != cutoutMode) {
                attributes.layoutInDisplayCutoutMode = cutoutMode;
                window.setAttributes(attributes);
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        controller.setAppearanceLightStatusBars(isDaylight);
        controller.setAppearanceLightNavigationBars(isDaylight);
        controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        if (immersive) {
            controller.hide(WindowInsetsCompat.Type.systemBars());
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars());
        }
        windowInsets.requestUpdate();
    }

    @Override
    public void onResume() {
        super.onResume();
        applyWindowRules();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            applyWindowRules();
        }
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applyWindowRules();
    }

    @Override
    public void onDestroy() {
        if (windowInsets != null) {
            windowInsets.destroy();
            windowInsets = null;
        }
        super.onDestroy();
    }
}
