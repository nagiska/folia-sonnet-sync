import { Buffer } from 'buffer';
import { installGlobalVisualizerFrameRateLimiter } from './utils/frameRateLimiter';
import { installConsoleLogCapture } from './utils/consoleLogBuffer';
import { installDebugModule } from './services/debug/debugModule';
import { installMemorySampleFeed } from './services/debug/memorySamples';
import { installNativeAndroidBridge } from './services/nativeAndroidBridge';
import { installAppleMusicAndroidBridge } from './services/appleMusicAndroidBridge';
import { installAndroidUiScale } from './platform/androidUiScale';
import './platform/androidUiScale.css';
import { isPerfCheckSurface } from './utils/appSurface';
// import { installCoverSizeAudit } from './services/debug/coverSizeSamples';
// @ts-ignore
globalThis.Buffer = Buffer;
// First, so the debug overlay's console tab has the startup lines too - they are where a failure
// to reach a library or restore a session shows up.
installConsoleLogCapture();
// Right after it, so the startup lines reach the runtime log file too and not only the in-memory
// buffer. Both no-op off Electron. See services/debug/debugModule.ts.
// Not in the performance check's window: the log pipe is the first-party windows' (the main process
// refuses it there), and the check writes its result through its own channel (electron/perfCheck.cjs).
if (!isPerfCheckSurface) {
    installDebugModule();
    installMemorySampleFeed();
}
// Android: makes the bundled bridge look like the desktop Folia Bridge extension, so the
// NetEase/QQ/KuGou API code inside the app answers instead of a remote server.
void installNativeAndroidBridge();
// Android: the Apple Music companion is a hidden WebView (FoliaAppleMusic plugin).
installAppleMusicAndroidBridge();
// Android: scale the UI down on phone landscape so the short screen fits the controls.
installAndroidUiScale();
// Cover size audit, left wired but switched off: it answered whether the provider CDNs honour the
// size in a cover URL - they do - and that is not a question worth re-asking every session. The
// collector and its panel are still in the tree, and `?probe=coverSizeAudit` still reaches them.
// To bring the tab back, uncomment this line and the four sites in DevDebugOverlay.tsx. It was dev
// only even then: a packaged build has nothing to do with the answer, so it should not pay the
// observer or the rows it retains.
// if (import.meta.env.DEV) installCoverSizeAudit();
installGlobalVisualizerFrameRateLimiter();

// 覆盖更新时旧版本残留的持久化数据可能让启动 hydration 抛错（清空重装则正常）。
// 这里兜底：bootstrap 加载失败时一次性清掉残留存储并重启，把「更新闪退」变成一次自动恢复；
// sessionStorage 标记防止无限重启循环。成功启动后清掉标记。
void import('./bootstrap').then(() => {
    try { sessionStorage.removeItem('folia_boot_recovered'); } catch { /* 隐私模式等不可用时忽略 */ }
}).catch((error) => {
    console.error('[boot] 启动失败，尝试清理旧版本残留数据后恢复', error);
    try {
        if (sessionStorage.getItem('folia_boot_recovered') !== '1') {
            sessionStorage.setItem('folia_boot_recovered', '1');
            localStorage.clear();
            location.reload();
        }
    } catch { /* 存储不可用时不再重试，避免循环 */ }
});
// window.__foliaDev and the ?skipStartup / ?mockSong launch flags (src/dev/devLaunchFlags.ts).
if (import.meta.env.DEV) void import('./dev/devTools');
