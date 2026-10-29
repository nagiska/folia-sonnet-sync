import { registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

// 当前文件：Android 系统媒体会话插件的类型包装；同步曲目、封面与播放进度并接收通知动作。

export type AndroidMediaSessionAction = 'play' | 'pause' | 'previous' | 'next' | 'like' | 'seek';

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
    /** `https` is downloaded natively and `data:` decoded natively; empty means no cover. */
    artworkUrl: string;
    /** Track length in milliseconds; 0 while it is still unknown. */
    durationMs: number;
    /** Playhead in milliseconds at the moment this was published. */
    positionMs: number;
    /** Drives `ACTION_SEEK_TO`; false hides the system progress handle. */
    seekable: boolean;
    canLike: boolean;
    isLiked: boolean;
    playing: boolean;
    labels: AndroidMediaSessionLabels;
}

export interface AndroidMediaSessionProgressOptions {
    /** Guards against a tick that left the WebView before the track changed. */
    title: string;
    positionMs: number;
    durationMs: number;
    playing: boolean;
    seekable: boolean;
}

export interface AndroidMediaSessionClearOptions {
    revision: number;
    sessionId: string;
}

export interface AndroidMediaSessionActionEvent {
    action: AndroidMediaSessionAction;
    /** Present for `seek`: the position the system UI asked for, in milliseconds. */
    positionMs?: number;
}

export interface AndroidMediaSessionPlugin {
    sync(options: AndroidMediaSessionSyncOptions): Promise<void>;
    progress(options: AndroidMediaSessionProgressOptions): Promise<void>;
    clear(options: AndroidMediaSessionClearOptions): Promise<void>;
    addListener(
        eventName: 'action',
        listener: (event: AndroidMediaSessionActionEvent) => void,
    ): Promise<PluginListenerHandle>;
}

export const androidMediaSession = registerPlugin<AndroidMediaSessionPlugin>('FoliaMediaSession');
