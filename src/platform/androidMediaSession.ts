import { registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

// 当前文件：Android 系统媒体会话插件的类型包装；同步曲目与播放状态并接收通知动作。

export type AndroidMediaSessionAction = 'play' | 'pause' | 'previous' | 'next' | 'like';

export interface AndroidMediaSessionLabels {
    play: string;
    pause: string;
    previous: string;
    next: string;
    like: string;
    unlike: string;
    applicationName: string;
}

export interface AndroidMediaSessionSyncOptions {
    /** Monotonic per-session counter; native drops updates older than the last one it accepted. */
    revision: number;
    /** Identifies one hook mount so native can reset the counter after a WebView reload. */
    sessionId: string;
    title: string;
    artist: string;
    album: string;
    canLike: boolean;
    isLiked: boolean;
    playing: boolean;
    labels: AndroidMediaSessionLabels;
}

export interface AndroidMediaSessionClearOptions {
    revision: number;
    sessionId: string;
}

export interface AndroidMediaSessionActionEvent {
    action: AndroidMediaSessionAction;
}

export interface AndroidMediaSessionPlugin {
    sync(options: AndroidMediaSessionSyncOptions): Promise<void>;
    clear(options: AndroidMediaSessionClearOptions): Promise<void>;
    addListener(
        eventName: 'action',
        listener: (event: AndroidMediaSessionActionEvent) => void,
    ): Promise<PluginListenerHandle>;
}

export const androidMediaSession = registerPlugin<AndroidMediaSessionPlugin>('FoliaMediaSession');
