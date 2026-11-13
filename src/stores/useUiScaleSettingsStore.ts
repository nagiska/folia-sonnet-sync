import { create } from 'zustand';
import { getStoredString, removeStoredKey, setStoredString } from './storagePrimitives';

// src/stores/useUiScaleSettingsStore.ts
// Android 手机横屏的界面缩放：设备类型（手机 / 平板 / 自动）与用户调的缩放百分比。
// 缩的是根字号（rem 基准），由 src/platform/androidUiScale.ts 落到 <html> 属性与 CSS 变量上；
// 这里只管「选了什么、生效值是多少」，不碰 DOM。手机横过来高度只剩 360~400，同一档控件互相压，
// 所以横屏在竖屏那档上再收一档（compact）。写死一个百分比在 6 寸到 7 寸、系统字号各异的机器上
// 必然两头不讨好，故交给滑条：没调过按设备类型给默认，调过一律以调的为准。

export const DEVICE_TYPE_STORAGE_KEY = 'folia_device_type';
export const UI_SCALE_STORAGE_KEY = 'folia_ui_scale';

export type DeviceType = 'phone' | 'tablet';
/** null = 自动（按屏幕短边推断）。 */
export type DeviceTypeSetting = DeviceType | null;

export const UI_SCALE_MIN = 60;
export const UI_SCALE_MAX = 110;
export const UI_SCALE_STEP = 2;
export const UI_SCALE_DEFAULT_PHONE = 86;
export const UI_SCALE_DEFAULT_TABLET = 100;
/** 横屏（compact）在竖屏那档上再收多少。 */
const UI_SCALE_COMPACT_OFFSET = 10;
/** 横屏档下限：滑条拉到最低也不至于小到读不出来。 */
const UI_SCALE_COMPACT_MIN = 55;
/** 手机短边上限（CSS px）：只用来在「没选过」时兜底推断，选过的一律以选择为准。 */
const PHONE_SHORT_EDGE_MAX_PX = 520;

/** 夹到滑条范围内并按步长对齐；存进去与读出来的都过这一道，脏值不会带进样式。 */
export const clampUiScale = (scale: number): number => {
    const snapped = Math.round(scale / UI_SCALE_STEP) * UI_SCALE_STEP;
    return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, snapped));
};

/** 没选过设备类型时的自动判断：安卓 WebView 里短边够小就是手机，否则平板。Web / Electron 一律平板（不缩）。 */
export const inferDeviceType = (): DeviceType => {
    if (typeof window === 'undefined') return 'tablet';
    if (typeof navigator === 'undefined' || !/Android/.test(navigator.userAgent)) return 'tablet';
    const shortEdge = Math.min(window.innerWidth, window.innerHeight);
    return shortEdge > 0 && shortEdge <= PHONE_SHORT_EDGE_MAX_PX ? 'phone' : 'tablet';
};

/** 选择优先，没选就自动判断。 */
export const resolveDeviceType = (deviceType: DeviceTypeSetting): DeviceType => (
    deviceType ?? inferDeviceType()
);

/** 没调过时按设备类型取默认：手机缩一档，平板不缩。 */
export const defaultUiScaleFor = (deviceType: DeviceTypeSetting): number => (
    resolveDeviceType(deviceType) === 'phone' ? UI_SCALE_DEFAULT_PHONE : UI_SCALE_DEFAULT_TABLET
);

/** 生效值：调过以调的为准（并夹回范围），没调过按设备类型取默认。 */
export const resolveUiScale = (stored: number | null, deviceType: DeviceTypeSetting): number => (
    stored === null ? defaultUiScaleFor(deviceType) : clampUiScale(stored)
);

/** 横屏那一档：在竖屏基础上再收一档，但不低于下限。 */
export const compactUiScaleFor = (normal: number): number => (
    Math.max(UI_SCALE_COMPACT_MIN, normal - UI_SCALE_COMPACT_OFFSET)
);

export const isLandscapeNow = (): boolean => (
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(orientation: landscape)').matches
);

const readStoredDeviceType = (): DeviceTypeSetting => {
    const saved = getStoredString(DEVICE_TYPE_STORAGE_KEY, '');
    return saved === 'phone' || saved === 'tablet' ? saved : null;
};

const readStoredUiScale = (): number | null => {
    if (typeof window === 'undefined') return null;
    const raw = localStorage.getItem(UI_SCALE_STORAGE_KEY);
    if (raw === null || raw === '') return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampUiScale(parsed) : null;
};

export type UiScaleSettingsState = {
    deviceType: DeviceTypeSetting;
    uiScale: number | null;
    setDeviceType: (deviceType: DeviceTypeSetting) => void;
    setUiScale: (uiScale: number | null) => void;
};

export const useUiScaleSettingsStore = create<UiScaleSettingsState>((set) => ({
    deviceType: readStoredDeviceType(),
    uiScale: readStoredUiScale(),
    setDeviceType: (deviceType) => {
        if (deviceType === null) removeStoredKey(DEVICE_TYPE_STORAGE_KEY);
        else setStoredString(DEVICE_TYPE_STORAGE_KEY, deviceType);
        set({ deviceType });
    },
    setUiScale: (uiScale) => {
        if (uiScale === null) removeStoredKey(UI_SCALE_STORAGE_KEY);
        else setStoredString(UI_SCALE_STORAGE_KEY, String(clampUiScale(uiScale)));
        set({ uiScale: uiScale === null ? null : clampUiScale(uiScale) });
    },
}));
