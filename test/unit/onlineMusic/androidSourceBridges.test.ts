import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFoliumSourceError } from '@/mods/folium/sources/errors';
import { createFoliumI18n } from '@/mods/folium/sources/i18n';
import type { WebSourceEnv } from '@/services/onlineMusic/web/foliumWebSource';

// env 契约接回 Android 本地登录：旧会话、游客并发注册、确认登录和退出都经过新版音源。

interface BridgeRequest {
    operation: string;
    method?: string;
    path?: string;
    query?: Record<string, string | number | boolean | undefined>;
    params?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
}
const storage = new Map<string, string>();
const envOf = (modId: string): WebSourceEnv => {
    const text = createFoliumI18n(key => key);
    return {
        modId,
        text: text.key,
        translate: text.text,
        error: createFoliumSourceError,
        isPureMusicText: () => false,
        call: async () => { throw new Error('No desktop RPC in this test'); },
        pageStore: id => ({
            get: key => storage.get(`${id}:${key}`) ?? null,
            set: (key, value) => { if (value === null) storage.delete(`${id}:${key}`); else storage.set(`${id}:${key}`, value); },
            keys: () => [...storage.keys()].filter(key => key.startsWith(`${id}:`)).map(key => key.slice(id.length + 1)),
        }),
    };
};
const bridgeOf = (handler: (request: BridgeRequest) => Promise<unknown>) => ({
    configured: (base: string) => base === 'extension',
    available: async () => true,
    request: async <T>(request: BridgeRequest): Promise<T> => await handler(request) as T,
});

beforeEach(() => {
    vi.resetModules();
    storage.clear();
    vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('local bridge injection', () => {
    it('keeps an existing NetEase login without registering a guest', async () => {
        storage.set('netease:cookie', 'MUSIC_U=old-account');
        const handler = vi.fn(async () => ({ code: 200, data: [] }));
        const { createSource } = await import('../../../sources/netease/core');
        createSource({ ...envOf('netease'), web: { apiBase: 'extension', bridge: bridgeOf(handler) } });
        const { neteaseApi } = await import('../../../sources/netease/core/netease');
        await neteaseApi.getSongUrl(1);
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith(expect.objectContaining({
            path: '/song/url/v1', query: expect.objectContaining({ cookie: 'MUSIC_U=old-account' }),
        }));
        expect(fetch).not.toHaveBeenCalled();
    });

    it('shares one NetEase guest registration across concurrent requests', async () => {
        const handler = vi.fn(async (request: BridgeRequest) => request.operation === '/register/anonimous'
            ? { cookie: 'MUSIC_A=guest' } : { code: 200, data: [] });
        const { createSource } = await import('../../../sources/netease/core');
        createSource({ ...envOf('netease'), web: { apiBase: 'extension', bridge: bridgeOf(handler) } });
        const { neteaseApi } = await import('../../../sources/netease/core/netease');
        await Promise.all([neteaseApi.getSongUrl(1), neteaseApi.getSongUrl(2)]);
        expect(handler.mock.calls.filter(([request]) => request.operation === '/register/anonimous')).toHaveLength(1);
        expect(storage.get('netease:anonymous_cookie')).toBe('MUSIC_A=guest');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('clears a rejected NetEase guest and registers a fresh one next time', async () => {
        storage.set('netease:anonymous_cookie', 'MUSIC_A=expired');
        const handler = vi.fn(async (request: BridgeRequest) => request.operation === '/register/anonimous'
            ? { cookie: 'MUSIC_A=fresh' } : request.query?.cookie === 'MUSIC_A=expired' ? { code: 301 } : { code: 200, data: [] });
        const { createSource } = await import('../../../sources/netease/core');
        createSource({ ...envOf('netease'), web: { apiBase: 'extension', bridge: bridgeOf(handler) } });
        const { neteaseApi } = await import('../../../sources/netease/core/netease');
        await neteaseApi.getSongUrl(1);
        expect(storage.has('netease:anonymous_cookie')).toBe(false);
        await neteaseApi.getSongUrl(2);
        expect(storage.get('netease:anonymous_cookie')).toBe('MUSIC_A=fresh');
    });

    it('keeps QQ confirmation cookies returned inside session.cookie', async () => {
        const handler = vi.fn(async () => ({ code: 803, session: { cookie: 'qqmusic_session=confirmed' } }));
        const { createSource } = await import('../../../sources/qq/core');
        createSource({ ...envOf('qq'), web: { apiBase: 'extension', relayUrl: url => url, bridge: bridgeOf(handler) } });
        const { requestQq } = await import('../../../sources/qq/core/qqTransport');
        await requestQq('login_qr_check', { key: 'qr-key' });
        expect(storage.get('qq:cookie')).toBe('qqmusic_session=confirmed');
        expect(handler).toHaveBeenCalledWith(expect.objectContaining({ operation: 'login_qr_check', method: 'GET' }));
        expect(fetch).not.toHaveBeenCalled();
    });

    it('maps QQ bridge refusal to an auth failure rather than fetching extension as a URL', async () => {
        const { createSource } = await import('../../../sources/qq/core');
        createSource({ ...envOf('qq'), web: {
            apiBase: 'extension', relayUrl: url => url,
            bridge: bridgeOf(async () => ({ __foliaBridgeError: 'AUTH_REQUIRED', message: 'login required' })),
        } });
        const { requestQq } = await import('../../../sources/qq/core/qqTransport');
        await expect(requestQq('user_detail')).rejects.toMatchObject({ code: 'auth-required' });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('mirrors a confirmed KuGou account and clears it even if logout answers late', async () => {
        let finishLogout: (value: unknown) => void = () => {};
        const handler = vi.fn(async (request: BridgeRequest): Promise<unknown> => {
            if (request.operation === 'logout') return await new Promise(resolve => { finishLogout = resolve; });
            return { data: { status: 4, userid: '7', token: 'account-token', dfid: 'device' } };
        });
        const changed = vi.fn();
        const { createWebKugouTransport } = await import('../../../sources/kugou/core/kugouTransport');
        const transport = createWebKugouTransport(envOf('kugou'), {
            apiBase: 'extension', md5: value => value, relayUrl: url => url, bridge: bridgeOf(handler), sessionChanged: changed,
        });
        await transport.request('login_qr_check');
        expect(changed).toHaveBeenLastCalledWith({ userId: '7', token: 'account-token', dfid: 'device' });
        const logout = transport.request('logout');
        transport.forgetAccount();
        finishLogout({ data: { status: 4, userid: '7', token: 'account-token' } });
        await logout;
        expect(storage.has('kugou:token')).toBe(false);
        expect(changed).toHaveBeenLastCalledWith({ userId: '', token: '', dfid: '' });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('does not replace a KuGou login with a public playlist owner', async () => {
        storage.set('kugou:userid', '7');
        storage.set('kugou:token', 'account-token');
        const { createWebKugouTransport } = await import('../../../sources/kugou/core/kugouTransport');
        const transport = createWebKugouTransport(envOf('kugou'), {
            apiBase: 'extension', md5: value => value, relayUrl: url => url,
            bridge: bridgeOf(async () => ({ data: { userid: '99', token: 'other-token' } })),
        });
        await transport.request('playlist_detail');
        expect(storage.get('kugou:userid')).toBe('7');
        expect(storage.get('kugou:token')).toBe('account-token');
    });

    it('registers an available Apple Music external-player source using the injected companion', async () => {
        const { createWebSource } = await import('../../../sources/appleMusic/core');
        const call = vi.fn(async () => ({ ok: true, data: { paused: true } }));
        const def = createWebSource({ ...envOf('apple-music'), platform: 'android', call: async <T>() => await call() as T });
        expect(def.getAvailability?.()).toEqual({ configured: true });
        expect(def.capabilities['playback.external@1']).toBeDefined();
        const { requestAppleMusic } = await import('../../../sources/appleMusic/client/appleMusicTransport');
        await expect(requestAppleMusic('pause')).resolves.toEqual({ paused: true });
        expect(call).toHaveBeenCalledTimes(1);
    });
});
