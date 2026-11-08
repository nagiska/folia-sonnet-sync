import { Buffer } from 'buffer';
import { installGlobalVisualizerFrameRateLimiter } from './utils/frameRateLimiter';
import { installConsoleLogCapture } from './utils/consoleLogBuffer';
import { installDebugModule } from './services/debug/debugModule';
import { installMemorySampleFeed } from './services/debug/memorySamples';
import { installNativeAndroidBridge } from './services/nativeAndroidBridge';
import { installAppleMusicAndroidBridge } from './services/appleMusicAndroidBridge';
// import { installCoverSizeAudit } from './services/debug/coverSizeSamples';
// @ts-ignore
globalThis.Buffer = Buffer;
// First, so the debug overlay's console tab has the startup lines too - they are where a failure
// to reach a library or restore a session shows up.
installConsoleLogCapture();
// Right after it, so the startup lines reach the runtime log file too and not only the in-memory
// buffer. Both no-op off Electron. See services/debug/debugModule.ts.
installDebugModule();
installMemorySampleFeed();
// Android: makes the bundled bridge look like the desktop Folia Bridge extension, so the
// NetEase/QQ/KuGou API code inside the app answers instead of a remote server.
void installNativeAndroidBridge();
// Android: the Apple Music companion is a hidden WebView (FoliaAppleMusic plugin).
installAppleMusicAndroidBridge();
// Cover size audit, left wired but switched off: it answered whether the provider CDNs honour the
// size in a cover URL - they do - and that is not a question worth re-asking every session. The
// collector and its panel are still in the tree, and `?probe=coverSizeAudit` still reaches them.
// To bring the tab back, uncomment this line and the four sites in DevDebugOverlay.tsx. It was dev
// only even then: a packaged build has nothing to do with the answer, so it should not pay the
// observer or the rows it retains.
// if (import.meta.env.DEV) installCoverSizeAudit();
installGlobalVisualizerFrameRateLimiter();

void import('./bootstrap');
// window.__foliaDev and the ?skipStartup / ?mockSong launch flags (src/dev/devLaunchFlags.ts).
if (import.meta.env.DEV) void import('./dev/devTools');
