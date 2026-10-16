import { CapacitorHttp } from '@capacitor/core';
import { isCapacitorAndroid } from '../../platform/runtime';

// 当前文件：仅为 Android 的 ngrok 网易云 API 使用原生 HTTP，避开浏览器提示页和跨域预检。

type NeteaseHttpResponse = Pick<Response, 'status' | 'text' | 'json'>;

const NGROK_NETEASE_HOST = 'disobey-name-author.ngrok-free.dev';

export const fetchNeteaseResponse = async (
    url: string,
    options: RequestInit = {},
): Promise<NeteaseHttpResponse> => {
    if (!isCapacitorAndroid() || !url.startsWith(`https://${NGROK_NETEASE_HOST}/`)) {
        return fetch(url, options);
    }

    // 网易云 transport 当前全部使用 GET；不要在未来新增写请求时静默丢弃请求体。
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
    // Capacitor 即使指定 text，也可能按 JSON Content-Type 返回已解析的数据。
    const body = typeof response.data === 'string'
        ? response.data
        : JSON.stringify(response.data) ?? '';
    return {
        status: response.status,
        text: async () => body,
        json: async () => JSON.parse(body),
    };
};
