import { CapacitorHttp } from '@capacitor/core';
import { isCapacitorAndroid } from '../../../platform/runtime';

// Android 的自建 API 使用原生 HTTP；由 web/netease.ts 注入音源，音源本身不依赖 Capacitor。

type NeteaseHttpResponse = Pick<Response, 'status' | 'ok' | 'text' | 'json'>;

export const NATIVE_NETEASE_HOST = 'api-enhancedtestnagisaki.vercel.app';

export const fetchNeteaseResponse = async (
    url: string,
    options: RequestInit = {},
): Promise<NeteaseHttpResponse> => {
    if (!isCapacitorAndroid() || !url.startsWith(`https://${NATIVE_NETEASE_HOST}/`)) {
        return fetch(url, options);
    }
    if ((options.method ?? 'GET').toUpperCase() !== 'GET' || options.body != null) {
        throw new Error('The native NetEase transport only supports GET requests.');
    }
    const headers = new Headers(options.headers);
    headers.set('ngrok-skip-browser-warning', 'true');
    const nativeHeaders: Record<string, string> = {};
    headers.forEach((value, key) => { nativeHeaders[key] = value; });
    const response = await CapacitorHttp.get({
        url,
        headers: nativeHeaders,
        responseType: 'text',
        connectTimeout: 15000,
        readTimeout: 30000,
    });
    const body = typeof response.data === 'string'
        ? response.data
        : JSON.stringify(response.data) ?? '';
    return {
        status: response.status,
        ok: response.status >= 200 && response.status < 300,
        text: () => Promise.resolve(body),
        json: () => Promise.resolve().then(() => JSON.parse(body) as unknown),
    };
};
