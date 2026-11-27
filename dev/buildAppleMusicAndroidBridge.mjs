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
    const sandbox = { window: {}, navigator: {}, console: { log: noop, info: noop, warn: noop, error: noop } };
    vm.runInNewContext(output[0].code, sandbox);
    for (const [operation, params] of [['librarySongs', {}], ['setRepeatOne', { enabled: true }], ['diagnostics', {}]]) {
        const expression = sandbox.window.__foliaAppleMusicBuild({ id: 'ci_protocol_check', operation, params });
        assert.equal(typeof expression, 'string', `${operation} must have a page expression`);
        new vm.Script(expression);
    }
    console.info('[AppleMusic] Android companion script generated and protocol smoke checks passed');
} finally {
    await build.close();
}
