import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 当前文件：覆盖 ngrok 原生通道的登录、首次匿名会话，以及其他平台的请求隔离。

const transport = vi.hoisted(() => ({
    nativeGet: vi.fn(),
    isAndroid: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
    CapacitorHttp: { get: transport.nativeGet },
}));
vi.mock('@/platform/runtime', () => ({
    isCapacitorAndroid: transport.isAndroid,
}));
vi.mock('@/services/onlineMusic/providerStorage', () => ({
    readProviderSessionValue: vi.fn(),
    writeProviderSessionValue: vi.fn(),
    removeProviderSessionValue: vi.fn(),
}));

import { fetchNeteaseResponse } from '@/services/onlineMusic/netease/neteaseHttp';
import { readProviderSessionValue, writeProviderSessionValue } from '@/services/onlineMusic/providerStorage';

const API_BASE = 'https://disobey-name-author.ngrok-free.dev';

describe('NetEase ngrok HTTP transport', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.resetAllMocks();
        transport.isAndroid.mockReturnValue(true);
        vi.stubEnv('VITE_NETEASE_API_BASE', API_BASE);
        vi.stubGlobal('window', {});
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    it('keeps the stored login cookie when requesting a playback URL through native HTTP', async () => {
        vi.mocked(readProviderSessionValue).mockImplementation((_provider, key) => (
            key === 'cookie' ? 'MUSIC_U=test-session; __csrf=test-csrf' : null
        ));
        transport.nativeGet.mockResolvedValue({
            status: 200,
            data: { code: 200, data: [{ url: 'https://music.example/song.mp3' }] },
        });
        const { neteaseApi } = await import('@/services/onlineMusic/netease/netease');

        const result = await neteaseApi.getSongUrl(347230);

        const request = transport.nativeGet.mock.calls[0][0];
        const url = new URL(request.url);
        expect(url.origin).toBe(API_BASE);
        expect(url.pathname).toBe('/song/url/v1');
        expect(url.searchParams.get('cookie')).toBe('MUSIC_U=test-session; __csrf=test-csrf');
        expect(request.headers['ngrok-skip-browser-warning']).toBe('true');
        expect(result.data[0].url).toBe('https://music.example/song.mp3');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('uses native HTTP for both first-time anonymous registration and the following song request', async () => {
        vi.mocked(readProviderSessionValue).mockReturnValue(null);
        transport.nativeGet
            .mockResolvedValueOnce({ status: 200, data: '{"code":200,"cookie":"MUSIC_A=anonymous"}' })
            .mockResolvedValueOnce({ status: 200, data: { code: 200, data: [{ url: 'https://music.example/song.mp3' }] } });
        const { neteaseApi } = await import('@/services/onlineMusic/netease/netease');

        await neteaseApi.getSongUrl(347230);

        expect(transport.nativeGet).toHaveBeenCalledTimes(2);
        expect(new URL(transport.nativeGet.mock.calls[0][0].url).pathname).toBe('/register/anonimous');
        expect(new URL(transport.nativeGet.mock.calls[1][0].url).searchParams.get('cookie')).toBe('MUSIC_A=anonymous');
        for (const [request] of transport.nativeGet.mock.calls) {
            expect(request.headers['ngrok-skip-browser-warning']).toBe('true');
        }
        expect(writeProviderSessionValue).toHaveBeenCalledWith('netease', 'anonymous_cookie', 'MUSIC_A=anonymous');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('preserves non-JSON HTTP diagnostics instead of treating an ngrok error page as API data', async () => {
        transport.nativeGet.mockResolvedValue({ status: 502, data: '<html>tunnel offline</html>' });
        const { neteaseApi } = await import('@/services/onlineMusic/netease/netease');

        await expect(neteaseApi.getLoginStatus()).rejects.toMatchObject({
            httpStatus: 502,
            message: expect.stringContaining('returned HTTP 502 without a JSON body'),
        });
    });

    it('keeps native connection failures tagged as network failures', async () => {
        transport.nativeGet.mockRejectedValue(new Error('connection timed out'));
        const { neteaseApi } = await import('@/services/onlineMusic/netease/netease');

        await expect(neteaseApi.getLoginStatus()).rejects.toMatchObject({ networkFailure: true });
    });

    it.each([
        [false, `${API_BASE}/login/status`],
        [true, 'https://api.example.com/login/status'],
        [true, 'https://disobey-name-author.ngrok-free.dev.example.com/login/status'],
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
