'use strict';

// Android companion 的只读诊断保留在本机入口，不向桌面音源的公开请求增加专有操作。
// 函数会串成页面表达式执行：仅引用函数内变量与页面 API，不依赖构建器生成的外部闭包。
async function readAndroidDiagnostics() {
    let mk = null;
    try { mk = window.MusicKit?.getInstance?.() ?? null; } catch { /* Page not ready. */ }
    const scrubText = value => String(value).replace(/https?:\/\/[^\s"'<>]+/g, link => {
        try { return new URL(link).host; } catch { return 'url'; }
    }).replace(/[A-Za-z0-9_\-]{40,}/g, '<blob>').slice(0, 200);
    const elements = Array.from(document.querySelectorAll('audio,video'));
    const element = document.querySelector('audio');
    const round = value => Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
    let drm = window.__foliaDrm;
    if (!drm || (drm.widevine !== true && Date.now() - Number(drm.at || 0) >= 60000)) {
        drm = { eme: typeof navigator.requestMediaKeySystemAccess === 'function', mediaSource: typeof MediaSource !== 'undefined',
            secure: window.isSecureContext === true, widevine: false, robustness: '', error: '', at: Date.now() };
        if (drm.eme) {
            for (const robustness of ['SW_SECURE_CRYPTO', '']) {
                try {
                    await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
                        initDataTypes: ['cenc'], audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"', ...(robustness ? { robustness } : {}) }],
                    }]);
                    drm.widevine = true;
                    drm.robustness = robustness || 'default';
                    break;
                } catch (error) {
                    if (!drm.error) drm.error = String(error?.name || 'rejected').slice(0, 80);
                }
            }
        }
        window.__foliaDrm = drm;
    }
    const hosts = {};
    try {
        for (const entry of performance.getEntriesByType('resource')) {
            let host;
            try { host = new URL(entry.name).host; } catch { continue; }
            if (!/(^|\.)(apple\.com|itunes\.apple\.com|applemusic\.com)$/.test(host) || host === 'xp.apple.com') continue;
            const row = hosts[host] || (hosts[host] = { count: 0, maxMs: 0 });
            row.count += 1;
            row.maxMs = Math.max(row.maxMs, Math.round(entry.duration || 0));
        }
    } catch { /* Resource timing may be unavailable. */ }
    const start = window.__foliaStart;
    return { ok: true, data: {
        drm,
        page: { url: location.origin + '/' + (location.pathname.split('/')[1] || ''), visibility: document.visibilityState,
            viewport: window.innerWidth + 'x' + window.innerHeight, userAgent: navigator.userAgent },
        player: mk ? {
            authorized: mk.isAuthorized === true, previewOnly: mk.previewOnly === true,
            storefront: String(mk.storefrontId || ''), country: String(mk.storefrontCountryCode || ''),
            state: Number.isInteger(mk.playbackState) ? mk.playbackState : null, isPlaying: mk.isPlaying === true,
            volume: round(mk.volume), itemIdLength: typeof mk.nowPlayingItem?.id === 'string' ? mk.nowPlayingItem.id.length : 0,
            queueLength: Number.isInteger(mk.queue?.length) ? mk.queue.length : Array.isArray(mk.queue?.items) ? mk.queue.items.length : null,
            queuePosition: Number.isInteger(mk.queue?.position) ? mk.queue.position : null,
            canSetQueue: typeof mk.setQueue === 'function', canPlay: typeof mk.play === 'function', canSeek: typeof mk.seekToTime === 'function',
        } : null,
        accountStorefront: typeof window.__foliaAccountStorefront === 'string' ? window.__foliaAccountStorefront : '',
        start: start ? { pending: start.pending === true, failed: start.failed === true, cancelled: start.cancelled === true,
            nudged: start.nudged === true, stage: String(start.stage || ''), error: scrubText(start.error || ''),
            ageMs: Math.max(0, Date.now() - Number(start.startedAt || 0)) } : null,
        audio: { elements: elements.length, paused: element ? element.paused === true : null, readyState: element?.readyState ?? null,
            networkState: element?.networkState ?? null, currentTime: element ? round(element.currentTime) : null,
            muted: element ? element.muted === true : null, volume: element ? round(element.volume) : null,
            hasSource: element ? Boolean(element.currentSrc || element.src) : false,
            errorCode: element?.error?.code ?? null, errorText: scrubText(element?.error?.message || '') },
        media: { total: elements.length, rows: elements.slice(0, 8).map((item, index) => ({ index, paused: item.paused === true,
            t: round(item.currentTime), ready: item.readyState, network: item.networkState, error: item.error?.code ?? null,
            source: Boolean(item.currentSrc || item.src) })) },
        mediaLog: Array.isArray(window.__foliaMedia) ? window.__foliaMedia.slice(-30) : null,
        states: Array.isArray(window.__foliaStates) ? window.__foliaStates.slice(-20) : null,
        eme: Array.isArray(window.__foliaEme) ? window.__foliaEme.slice(-20) : null,
        hosts, online: navigator.onLine === true,
        log: Array.isArray(window.__foliaLog) ? window.__foliaLog.slice(-40).map(scrubText) : null,
    } };
}

const diagnosticsExpression = () => `(${readAndroidDiagnostics.toString()})()`;
module.exports = { diagnosticsExpression };
