import source from 'virtual:folia-source/appleMusic';
import { createWebSource } from '../../../../sources/appleMusic/core';
import type { AppleMusicBridgeResult, AppleMusicOperation, AppleMusicParams } from '../../../../sources/appleMusic/core';
import { isCapacitorAndroid } from '../../../platform/runtime';
import { registerFoliumWebSource } from './foliumWebSource';

// Android 也使用 Folium 2 的音源注册与错误适配，调用交给已安装的隐藏 WebView companion。

export type { AppleMusicBridgeResult, AppleMusicOperation, AppleMusicParams } from '../../../../sources/appleMusic/core';

const callCompanion = async <T>(name: string, ...args: unknown[]): Promise<T> => {
    const request = (window as Window & {
        foliaAppleMusicRequest?: (operation: AppleMusicOperation, params?: AppleMusicParams) => Promise<AppleMusicBridgeResult>;
    }).foliaAppleMusicRequest;
    if (name !== 'request' || typeof request !== 'function') throw new Error('[AppleMusic] Android companion is unavailable');
    return await request(args[0] as AppleMusicOperation, args[1] as AppleMusicParams) as T;
};

/** Registers only in the native Android host; a browser has no companion. */
export const registerWebSource = (): string[] => {
    if (!isCapacitorAndroid()) return [];
    return registerFoliumWebSource({
        package: source,
        create: env => createWebSource({ ...env, platform: 'android', call: callCompanion }),
    });
};
