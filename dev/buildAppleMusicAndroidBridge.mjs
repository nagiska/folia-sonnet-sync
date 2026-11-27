import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { rolldown } from 'rolldown';

// CI 从当前 companion 源码生成 Android 注入脚本，避免已提交的旧 bundle 与新版音源协议脱节。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = await rolldown({
    input: path.join(root, 'dev/appleMusicBridgeEntry.cjs'),
    platform: 'browser',
    tsconfig: false,
    onLog(level, log, defaultHandler) {
        if (log.code === 'UNRESOLVED_IMPORT') throw new Error(log.message);
        defaultHandler(level, log);
    },
});
try {
    const { output } = await build.write({
        file: path.join(root, 'android/app/src/main/assets/appleMusicBridge.js'),
        format: 'iife',
        codeSplitting: false,
        sourcemap: false,
    });
    assert.equal(output.length, 1, 'The Android injection must be a single script');
    assert.equal(output[0].type, 'chunk');
    const noop = () => {};
    let now = 1000;
    let playCalls = 0;
    const queues = [];
    const storefronts = [];
    const player = {
        isAuthorized: true, storefrontId: 'cn', repeatMode: 0, playbackState: 0, currentPlaybackTime: 0,
        api: { v3: { music: async route => ({ status: 200, data: { data: route === 'v1/me/storefront' ? [{ id: 'us' }] : [] } }) } },
        setQueue: async options => {
            queues.push(options);
            player.playbackState = options.song === '1' ? 2 : 0;
        },
        play: async () => { playCalls += 1; },
        unauthorize: async () => { player.isAuthorized = false; },
    };
    const sandbox = {
        window: {
            MusicKit: { getInstance: () => player }, __foliaCompanionHost: 'android',
            FoliaAppleMusicBridge: { storefront: region => storefronts.push(region) },
        },
        navigator: { onLine: true },
        document: { querySelectorAll: () => [], querySelector: () => null, visibilityState: 'hidden' },
        location: { origin: 'https://music.apple.com', pathname: '/cn/' },
        performance: { getEntriesByType: () => [] },
        Date: { now: () => now },
        URL,
        console: { log: noop, info: noop, warn: noop, error: noop },
    };
    const context = vm.createContext(sandbox);
    vm.runInContext(output[0].code, context);
    const run = async (operation, params = {}) => {
        const expression = sandbox.window.__foliaAppleMusicBuild({ id: 'ci_protocol_check', operation, params });
        assert.equal(typeof expression, 'string', `${operation} must have a page expression`);
        // Match Java's actual Promise.resolve wrapper too: an unparenthesized comma expression loses the result.
        const result = await vm.runInContext(`Promise.resolve(${expression})`, context);
        assert.equal(result?.ok, true, `${operation} must return its companion answer`);
        return result.data;
    };
    await run('playSong', { catalogId: '1' });
    assert.equal(player.storefrontId, 'us');
    assert.deepEqual(storefronts, ['us']);
    assert.equal(queues[0].startPlaying, true);
    assert.equal(Object.hasOwn(queues[0], 'startTime'), false);
    assert.equal(playCalls, 0, 'A queue already starting must not receive a second play()');
    await run('playSong', { catalogId: '2', startSec: 7 });
    assert.equal(queues[1].startTime, 7);
    assert.equal(playCalls, 1);
    now += 3000;
    await run('playbackStatus');
    assert.equal(playCalls, 1);
    now += 2000;
    await run('playbackStatus');
    await run('playbackStatus');
    assert.equal(playCalls, 2, 'An idle WebView start must be retried once');
    await run('librarySongs');
    await run('setRepeatOne', { enabled: true });
    assert.equal(player.repeatMode, 1);
    assert.equal((await run('diagnostics')).start.nudged, true);
    await run('logout');
    assert.equal(player.isAuthorized, false);
    assert.equal(sandbox.window.__foliaStorefront, null);
    assert.equal(sandbox.window.__foliaStart, null);
    console.info('[AppleMusic] Android companion script generated and protocol smoke checks passed');
} finally {
    await build.close();
}
