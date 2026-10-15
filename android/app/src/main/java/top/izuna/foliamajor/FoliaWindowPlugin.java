package top.izuna.foliamajor;

import android.app.Activity;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// 提供单次窗口配置入口，严格校验前端参数并在主线程更新窗口。
@CapacitorPlugin(name = "FoliaWindow")
public class FoliaWindowPlugin extends Plugin {
    @PluginMethod
    public void configure(PluginCall call) {
        Object immersive = call.getData().opt("immersive");
        Object isDaylight = call.getData().opt("isDaylight");
        if (!(immersive instanceof Boolean) || !(isDaylight instanceof Boolean)) {
            call.reject("immersive and isDaylight must be booleans");
            return;
        }
        getBridge().executeOnMainThread(() -> {
            Activity activity = getActivity();
            if (!(activity instanceof MainActivity) || activity.isFinishing() || activity.isDestroyed()) {
                call.reject("FoliaWindow activity is unavailable");
                return;
            }
            ((MainActivity) activity).configureWindow((Boolean) immersive, (Boolean) isDaylight);
            call.resolve();
        });
    }
}
