import { androidWindow } from './androidWindow';
import { isCapacitorAndroid } from './runtime';
import {
    compactUiScaleFor,
    isLandscapeNow,
    resolveDeviceType,
    resolveUiScale,
    useUiScaleSettingsStore,
} from '../stores/useUiScaleSettingsStore';

// src/platform/androidUiScale.ts
// 把界面缩放落到文档根上：手机横屏时整屏缩一档（rem 基准），让矮屏放得下控件。
// 缩的是根字号而不是 zoom —— zoom 只把元素画小、layout viewport 不变，100vw/100dvh 会缩到一角留白；
// 动 rem 基准则 Tailwind 的间距/字号/圆角按比例缩小，% / flex / dvh 弹性布局原样铺满。
// 是否缩、缩多少由 useUiScaleSettingsStore 给；这里只负责写 <html> 属性与 CSS 变量，并在手机横屏时
// 让原生收回安全区与系统栏（高度本来就只有 360~400，再让掉状态栏 + 手势条内容区就没了）。
// 样式全在 androidUiScale.css 里读这几个属性，组件不需要知道自己在手机还是平板上。

let installed = false;
let lastCompact: boolean | null = null;

/** 把设备类型与缩放档位写到 <html>，并按需通知原生收回安全区 / 系统栏。 */
export const applyAndroidUiScale = (): void => {
    if (typeof document === 'undefined' || !isCapacitorAndroid()) return;
    const { deviceType, uiScale } = useUiScaleSettingsStore.getState();
    const resolved = resolveDeviceType(deviceType);
    const landscape = isLandscapeNow();
    // 只有手机横屏才进 compact：平板横屏本来就够宽，手机竖屏按正常档。
    const compact = resolved === 'phone' && landscape;
    const root = document.documentElement;
    root.setAttribute('data-folia-device-resolved', resolved);
    root.setAttribute('data-folia-ui-scale', compact ? 'compact' : 'normal');
    const scale = resolveUiScale(uiScale, deviceType);
    root.style.setProperty('--folia-ui-scale-normal', `${scale}%`);
    root.style.setProperty('--folia-ui-scale-compact', `${compactUiScaleFor(scale)}%`);
    // 原生只在档位真正变化时通知一次，避免 resize 高频调用打进主线程。
    if (compact !== lastCompact) {
        lastCompact = compact;
        void androidWindow.setLandscapeCompact({ enabled: compact }).catch(() => undefined);
    }
};

/** 启动时装一次：立刻应用，并监听转屏 / 尺寸 / 设置变化。仅安卓 WebView 生效。 */
export const installAndroidUiScale = (): void => {
    if (installed || typeof window === 'undefined' || !isCapacitorAndroid()) return;
    installed = true;
    applyAndroidUiScale();
    const update = () => applyAndroidUiScale();
    window.addEventListener('orientationchange', update);
    window.addEventListener('resize', update);
    if (typeof window.matchMedia === 'function') {
        window.matchMedia('(orientation: landscape)').addEventListener?.('change', update);
    }
    useUiScaleSettingsStore.subscribe(update);
};
