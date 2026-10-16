package top.izuna.foliamajor;

import android.graphics.Rect;
import android.os.Build;
import android.view.View;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.Bridge;
import com.getcapacitor.WebViewListener;
import java.util.Locale;

// 将稳定安全区写入页面，仅由原生父容器处理键盘遮挡。
final class FoliaWindowInsets {
    private static final int SAFE_TYPES = WindowInsetsCompat.Type.systemBars()
        | WindowInsetsCompat.Type.displayCutout();
    private final WebView webView;
    private final View parent;
    private final Rect visibleFrame = new Rect();
    private final int[] screenLocation = new int[2];
    private final PageListener pageListener = new PageListener(this);
    private WindowInsetsCompat lastInsets;
    private Insets safeArea = Insets.NONE;
    private boolean keyboardVisible;
    private boolean destroyed;
    private String lastScript;
    private final View.OnLayoutChangeListener layoutListener = (v, l, t, r, b, ol, ot, or, ob) -> {
        if (lastInsets != null) {
            updateInsets(lastInsets, false);
        }
    };

    FoliaWindowInsets(WebView webView) {
        this.webView = webView;
        this.parent = (View) webView.getParent();
    }

    void install(Bridge bridge) {
        ViewCompat.setOnApplyWindowInsetsListener(parent, (view, insets) -> {
            lastInsets = insets;
            updateInsets(insets, false);
            // 显式清零已处理的类型，避免 WebView 再次应用安全区或键盘缩放。
            return new WindowInsetsCompat.Builder(insets)
                .setDisplayCutout(null)
                .setInsets(SAFE_TYPES | WindowInsetsCompat.Type.ime(), Insets.NONE)
                .setInsetsIgnoringVisibility(SAFE_TYPES, Insets.NONE)
                .setVisible(WindowInsetsCompat.Type.ime(), false)
                .build();
        });
        parent.addOnLayoutChangeListener(layoutListener);
        bridge.addWebViewListener(pageListener);
        requestUpdate();
    }

    void requestUpdate() {
        if (!destroyed) {
            parent.requestLayout();
            ViewCompat.requestApplyInsets(parent);
        }
    }

    // 旧系统仅补足 resize 后仍被遮住的区域，避免 adjustResize 双重缩小。
    private void updateInsets(WindowInsetsCompat insets, boolean force) {
        if (destroyed) {
            return;
        }
        safeArea = insets.getInsetsIgnoringVisibility(SAFE_TYPES);
        keyboardVisible = insets.isVisible(WindowInsetsCompat.Type.ime());
        int bottom = 0;
        if (keyboardVisible) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                bottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom;
            } else {
                parent.getWindowVisibleDisplayFrame(visibleFrame);
                parent.getLocationOnScreen(screenLocation);
                if (!visibleFrame.isEmpty()) {
                    bottom = Math.max(0, screenLocation[1] + parent.getHeight() - visibleFrame.bottom);
                }
            }
        }
        if (parent.getPaddingLeft() != 0 || parent.getPaddingTop() != 0
            || parent.getPaddingRight() != 0 || parent.getPaddingBottom() != bottom) {
            parent.setPadding(0, 0, 0, bottom);
        }
        injectSafeArea(force);
    }

    // 缓存脚本避免重复注入；新文档提交时必须强制恢复 CSS 和运行环境标记。
    private void injectSafeArea(boolean force) {
        if (destroyed) {
            return;
        }
        float density = webView.getResources().getDisplayMetrics().density;
        String script = String.format(Locale.US,
            "(function(){var e=document.documentElement;if(!e)return;"
                + "e.dataset.runtime='capacitor-android';var s=e.style;"
                + "s.setProperty('--folia-safe-area-top','%.3fpx');"
                + "s.setProperty('--folia-safe-area-right','%.3fpx');"
                + "s.setProperty('--folia-safe-area-bottom','%.3fpx');"
                + "s.setProperty('--folia-safe-area-left','%.3fpx');})()",
            safeArea.top / density, safeArea.right / density,
            (keyboardVisible ? 0 : safeArea.bottom) / density, safeArea.left / density);
        if (force || !script.equals(lastScript)) {
            lastScript = script;
            webView.evaluateJavascript(script, null);
        }
    }

    void destroy() {
        destroyed = true;
        ViewCompat.setOnApplyWindowInsetsListener(parent, null);
        parent.removeOnLayoutChangeListener(layoutListener);
        // Capacitor 没有移除 WebViewListener 的入口，断开 owner 避免保留 Activity。
        pageListener.owner = null;
        lastInsets = null;
    }

    private static final class PageListener extends WebViewListener {
        private FoliaWindowInsets owner;

        PageListener(FoliaWindowInsets owner) {
            this.owner = owner;
        }

        @Override
        public void onPageCommitVisible(WebView view, String url) {
            if (owner != null) {
                WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(owner.parent);
                if (insets != null) {
                    owner.lastInsets = insets;
                    owner.updateInsets(insets, true);
                } else {
                    owner.injectSafeArea(true);
                }
                owner.requestUpdate();
            }
        }
    }
}
