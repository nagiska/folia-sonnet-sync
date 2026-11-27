import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFoliumSourceError } from '@/mods/folium/sources/errors';
import { createFoliumI18n } from '@/mods/folium/sources/i18n';

// 原生 HTTP 通过 env 注入新版音源，保留旧登录与匿名会话，并且不接管其他 API 主机。

const transport = vi.hoisted(() => ({ nativeGet: vi.fn(), isAndroid: vi.fn() }));
vi.mock('@capacitor/core', () => ({ CapacitorHttp: { get: transport.nativeGet } }));
vi.mock('@/platform/runtime', () => ({ isCapacitorAndroid: transport.isAndroid }));

import { fetchNeteaseResponse, NATIVE_NETEASE_HOST } from '@/services/onlineMusic/web/neteaseHttp';

const API_BASE = `https://${NATIVE_NETEASE_HOST}`;
const storage = new Map<string, string>();
const loadApi = async () => {
    const { createSource } = await import('../../../sources/netease/core');
    const texts = createFoliumI18n(key => key);
    createSource({
        modId: 'netease',
        call: async () => { throw new Error('No desktop RPC in this test'); },
        text: texts.key,
        translate: texts.text,
        error: createFoliumSourceError,
        isPureMusicText: () => false,
        pageStore: () => ({
            get: key => storage.get(key) ?? null,
            set: (key, value) => { if (value === null) storage.delete(key); else storage.set(key, value); },
            keys: () => [...storage.keys()],
        }),
        web: { apiBase: API_BASE, fetch: fetchNeteaseResponse },
    });
    return (await import('../../../sources/netease/core/netease')).neteaseApi;
};

describe('NetEase native HTTP transport', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.resetAllMocks();
        storage.clear();
        transport.isAndroid.mockReturnValue(true);
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

    it('keeps the stored login cookie when requesting a playback URL through native HTTP', async () => {
        storage.set('cookie', 'MUSIC_U=test-session; __csrf=test-csrf');
        transport.nativeGet.mockResolvedValue({ status: 200, data: { code: 200, data: [{ url: 'https://music.example/song.mp3' }] } });
        const result = await (await loadApi()).getSongUrl(347230);
        const request = transport.nativeGet.mock.calls[0][0];
        const url = new URL(request.url);
        expect(url.origin).toBe(API_BASE);
        expect(url.pathname).toBe('/song/url/v1');
        expect(url.searchParams.get('cookie')).toBe('MUSIC_U=test-session; __csrf=test-csrf');
        expect(request.headers['ngrok-skip-browser-warning']).toBe('true');
        expect(result.data[0].url).toBe('https://music.example/song.mp3');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('uses native HTTP for first anonymous registration and the following request', async () => {
        transport.nativeGet
            .mockResolvedValueOnce({ status: 200, data: '{"code":200,"cookie":"MUSIC_A=anonymous"}' })
            .mockResolvedValueOnce({ status: 200, data: { code: 200, data: [{ url: 'https://music.example/song.mp3' }] } });
        await (await loadApi()).getSongUrl(347230);
        expect(transport.nativeGet).toHaveBeenCalledTimes(2);
        expect(new URL(transport.nativeGet.mock.calls[0][0].url).pathname).toBe('/register/anonimous');
        expect(new URL(transport.nativeGet.mock.calls[1][0].url).searchParams.get('cookie')).toBe('MUSIC_A=anonymous');
        expect(storage.get('anonymous_cookie')).toBe('MUSIC_A=anonymous');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('preserves non-JSON HTTP diagnostics', async () => {
        transport.nativeGet.mockResolvedValue({ status: 502, data: '<html>tunnel offline</html>' });
        await expect((await loadApi()).getLoginStatus()).rejects.toMatchObject({
            httpStatus: 502, message: expect.stringContaining('returned HTTP 502 without a JSON body'),
        });
    });

    it('tags native connection failures as network failures', async () => {
        transport.nativeGet.mockRejectedValue(new Error('connection timed out'));
        await expect((await loadApi()).getLoginStatus()).rejects.toMatchObject({ networkFailure: true });
    });

    it.each([
        [false, `${API_BASE}/login/status`],
        [true, 'https://api.example.com/login/status'],
        [true, `https://${NATIVE_NETEASE_HOST}.example.com/login/status`],
        [true, '/netease/login/status'],
    ])('preserves browser fetch for Android=%s and URL=%s', async (android, url) => {
        transport.isAndroid.mockReturnValue(android);
        const response = new Response('{"code":200}');
        vi.mocked(fetch).mockResolvedValue(response);
        const options = { credentials: 'include' as const };
        expect(await fetchNeteaseResponse(url, options)).toBe(response);
        expect(fetch).toHaveBeenCalledWith(url, options);
        expect(transport.nativeGet).not.toHaveBeenCalled();
    });
});
