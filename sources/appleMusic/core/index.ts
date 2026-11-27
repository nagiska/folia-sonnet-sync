import type { FoliumSourceDef } from '@folia/folium';
import { connectAppleMusicTransport, type AppleMusicTransportEnv } from '../client/appleMusicTransport';
import { connectAppleMusicLibraryName } from '../client/appleMusicData';
import { createAppleMusicSource, type AppleMusicSourceEnv } from '../client/appleMusicProvider';

// Android 的 WebView companion 通过注入的 call 契约复用同一音源；不把宿主或 Capacitor 引入模组。

export type { AppleMusicBridgeResult, AppleMusicOperation, AppleMusicParams } from '../client/appleMusicTransport';

export interface AppleMusicHostEnv extends AppleMusicTransportEnv, AppleMusicSourceEnv {
    translate(key: string): string;
}

/** Builds the source with the host's companion transport and locale names. */
export const createWebSource = (env: AppleMusicHostEnv): FoliumSourceDef => {
    connectAppleMusicTransport(env);
    connectAppleMusicLibraryName(() => env.translate('libraryPlaylistName'));
    return createAppleMusicSource(env);
};
