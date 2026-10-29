import { useEffect, useRef } from 'react';
import { androidMediaSession } from '../platform/androidMediaSession';
import type {
    AndroidMediaSessionAction,
    AndroidMediaSessionLabels,
} from '../platform/androidMediaSession';
import { isCapacitorAndroid } from '../platform/runtime';

// 当前文件：把 Folia 的曲目、封面与播放进度同步到 Android 系统媒体会话，并转发通知按钮。
//
// State flows one way: this hook publishes metadata, artwork and playback state. Commands flow the
// other way: native action events call the App's latest callbacks, so a notification press runs the
// same path as an on-screen control. Actions can only be handled while this WebView is alive and the
// listener is registered; killing the WebView leaves neither the session owner nor a command target.

export type UseAndroidMediaSessionBridgeOptions = {
    title: string | null;
    artist: string | null;
    album: string | null;
    /** The cover the player is showing right now; `https` and WebView-local URLs are both accepted. */
    coverUrl?: string | null;
    /** Track length in milliseconds, 0 while it is still unknown. */
    durationMs?: number;
    /** Reads the displayed track's playhead, in milliseconds, when the session needs it. */
    getPositionMs?: () => number;
    /** Honours a seek the system UI asked for; the position is in milliseconds. */
    onSeek?: (positionMs: number) => void;
    /** Whether the system panel should offer a seekable progress bar. */
    seekable?: boolean;
    /** Whether the current track can be liked at all; hides the custom notification action. */
    canLike: boolean;
    isLiked: boolean;
    playing: boolean;
    controlsDisabled?: boolean;
    play: () => Promise<void> | void;
    pause: () => void;
    previous: () => void;
    next: () => Promise<void> | void;
    /** Must be the App's current handleLike; this hook never touches a platform adapter. */
    onLike: () => void;
    labels: AndroidMediaSessionLabels;
};

type AndroidMediaSessionCommand = () => Promise<void> | void;

const logPrefix = '[AndroidMediaSession]';

// Android advances the bar from the published state and speed, so a tick only corrects the drift.
const PROGRESS_INTERVAL_MS = 5000;
const ARTWORK_CACHE_LIMIT = 8;

const createSessionId = (): string => (
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
);

// Covers read here are keyed by their own URL: a new track brings its own, and the map is capped.
const artworkCache = new Map<string, string>();

const rememberArtwork = (key: string, dataUrl: string): void => {
    if (artworkCache.size >= ARTWORK_CACHE_LIMIT) {
        const oldest = artworkCache.keys().next();
        if (!oldest.done) artworkCache.delete(oldest.value);
    }
    artworkCache.set(key, dataUrl);
};

const readAsDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the artwork bytes'));
    reader.readAsDataURL(blob);
});

/**
 * Artwork travels as a URL: native downloads `https` and decodes `data:` on its own thread. The
 * blob URLs the cover cache mints only exist inside this WebView, and cleartext `http` is refused by
 * the manifest, so both are read here and handed over as bytes; a cover that cannot be read simply
 * leaves the notification without one.
 */
export const resolveAndroidMediaSessionArtwork = async (coverUrl: string): Promise<string> => {
    const trimmed = coverUrl.trim();
    if (!trimmed) return '';
    if (/^(https:|data:image\/)/i.test(trimmed)) return trimmed;

    const cached = artworkCache.get(trimmed);
    if (cached) return cached;

    try {
        const response = await fetch(trimmed);
        if (!response.ok) throw new Error(`Artwork request failed: ${response.status}`);
        const blob = await response.blob();
        if (blob.size <= 0 || !blob.type.startsWith('image/')) {
            throw new Error('Artwork response is not an image');
        }
        const dataUrl = await readAsDataUrl(blob);
        if (dataUrl) rememberArtwork(trimmed, dataUrl);
        return dataUrl;
    } catch (error) {
        console.warn(`${logPrefix} Could not prepare the notification artwork`, error);
        return '';
    }
};

export function useAndroidMediaSessionBridge({
    title,
    artist,
    album,
    coverUrl = null,
    durationMs = 0,
    getPositionMs,
    onSeek,
    seekable = false,
    canLike,
    isLiked,
    playing,
    controlsDisabled = false,
    play,
    pause,
    previous,
    next,
    onLike,
    labels,
}: UseAndroidMediaSessionBridgeOptions): void {
    const sessionIdRef = useRef<string | null>(null);
    if (sessionIdRef.current === null) {
        sessionIdRef.current = createSessionId();
    }
    const revisionRef = useRef(0);

    const playRef = useRef(play);
    const pauseRef = useRef(pause);
    const previousRef = useRef(previous);
    const nextRef = useRef(next);
    const onLikeRef = useRef(onLike);
    const onSeekRef = useRef(onSeek);
    const getPositionMsRef = useRef(getPositionMs);
    const canLikeRef = useRef(canLike);
    const controlsDisabledRef = useRef(controlsDisabled);
    const labelsRef = useRef(labels);

    useEffect(() => {
        playRef.current = play;
    }, [play]);

    useEffect(() => {
        pauseRef.current = pause;
    }, [pause]);

    useEffect(() => {
        previousRef.current = previous;
    }, [previous]);

    useEffect(() => {
        nextRef.current = next;
    }, [next]);

    useEffect(() => {
        onLikeRef.current = onLike;
    }, [onLike]);

    // The playhead is read at publish time, never captured: a closure over it would go stale between
    // ticks, and a new function identity every render must not restart the timer below.
    useEffect(() => {
        onSeekRef.current = onSeek;
    }, [onSeek]);

    useEffect(() => {
        getPositionMsRef.current = getPositionMs;
    }, [getPositionMs]);

    useEffect(() => {
        canLikeRef.current = canLike;
    }, [canLike]);

    useEffect(() => {
        controlsDisabledRef.current = controlsDisabled;
    }, [controlsDisabled]);

    useEffect(() => {
        labelsRef.current = labels;
    }, [labels]);

    const takeRevision = (): number => {
        revisionRef.current += 1;
        return revisionRef.current;
    };

    useEffect(() => {
        if (!isCapacitorAndroid()) return;

        const invoke = (command: AndroidMediaSessionCommand) => {
            try {
                const result = command();
                if (result && typeof result.then === 'function') {
                    void result.catch((error: unknown) => {
                        console.warn(`${logPrefix} Native action failed`, error);
                    });
                }
            } catch (error) {
                console.warn(`${logPrefix} Native action failed`, error);
            }
        };

        const handleAction = (action: AndroidMediaSessionAction, positionMs?: number) => {
            if (controlsDisabledRef.current) return;
            switch (action) {
                case 'play':
                    invoke(playRef.current);
                    break;
                case 'pause':
                    invoke(pauseRef.current);
                    break;
                case 'previous':
                    invoke(previousRef.current);
                    break;
                case 'next':
                    invoke(nextRef.current);
                    break;
                case 'like':
                    if (canLikeRef.current) invoke(onLikeRef.current);
                    break;
                case 'seek':
                    // Seeking from the system panel is the same statement as seeking from the app's
                    // own bar, so it goes through the App's seek rather than moving anything here.
                    if (typeof positionMs === 'number' && Number.isFinite(positionMs)) {
                        invoke(() => onSeekRef.current?.(Math.max(0, positionMs)));
                    }
                    break;
                default:
                    break;
            }
        };

        const handle = androidMediaSession
            .addListener('action', event => {
                const action = event?.action;
                if (
                    action === 'play'
                    || action === 'pause'
                    || action === 'previous'
                    || action === 'next'
                    || action === 'like'
                    || action === 'seek'
                ) {
                    handleAction(action, event?.positionMs);
                }
            })
            .catch(error => {
                console.warn(`${logPrefix} Could not listen for native actions`, error);
                return null;
            });

        return () => {
            void handle
                .then(listener => listener?.remove())
                .catch(error => {
                    console.warn(`${logPrefix} Could not remove the native action listener`, error);
                });
        };
    }, []);

    // A new labels object with the same words must not republish the notification; the joined
    // values are the real dependency, while labelsRef supplies the object.
    const labelsKey = [
        labels.play,
        labels.pause,
        labels.previous,
        labels.next,
        labels.like,
        labels.unlike,
        labels.applicationName,
    ].join('\n');

    useEffect(() => {
        if (!isCapacitorAndroid()) return;

        const sessionId = sessionIdRef.current ?? '';
        const trimmedTitle = title ? title.trim() : '';
        const revision = takeRevision();
        let disposed = false;

        const publish = async () => {
            // Empty metadata is a normal state: clear the session instead of rejecting a sync call.
            if (!trimmedTitle) {
                try {
                    await androidMediaSession.clear({ revision, sessionId });
                } catch (error) {
                    console.warn(`${logPrefix} Could not clear native media session`, error);
                }
                return;
            }

            const artworkUrl = await resolveAndroidMediaSessionArtwork(coverUrl ?? '');
            // A newer track already took a higher revision; native would drop this one anyway.
            if (disposed) return;

            try {
                await androidMediaSession.sync({
                    revision,
                    sessionId,
                    title: trimmedTitle,
                    artist: artist ?? '',
                    album: album ?? '',
                    artworkUrl,
                    durationMs: Math.max(0, Math.round(durationMs)),
                    positionMs: Math.max(0, Math.round(getPositionMsRef.current?.() ?? 0)),
                    seekable,
                    canLike,
                    isLiked,
                    playing,
                    labels: labelsRef.current,
                });
            } catch (error) {
                console.warn(`${logPrefix} Could not sync native media session`, error);
            }
        };

        void publish();

        return () => {
            disposed = true;
        };
    }, [album, artist, canLike, coverUrl, durationMs, isLiked, labelsKey, playing, seekable, title]);

    // The notification's progress bar follows this. A tick carries the title it was published for,
    // so one that left the WebView before the track changed cannot move the bar of its successor -
    // and unlike a metadata sync it never takes a revision, which would drop that sync's cover.
    useEffect(() => {
        if (!isCapacitorAndroid()) return;

        const trimmedTitle = title ? title.trim() : '';
        if (!trimmedTitle) return;

        const push = () => {
            void androidMediaSession.progress({
                title: trimmedTitle,
                positionMs: Math.max(0, Math.round(getPositionMsRef.current?.() ?? 0)),
                durationMs: Math.max(0, Math.round(durationMs)),
                playing,
                seekable,
            }).catch(error => {
                console.warn(`${logPrefix} Could not sync native playback progress`, error);
            });
        };

        // Pausing is final: one write leaves the bar where the listener stopped it, and a paused
        // track has nothing new to say until it plays again or the length arrives.
        push();
        if (!playing) return;

        const timer = window.setInterval(push, PROGRESS_INTERVAL_MS);
        return () => window.clearInterval(timer);
    }, [durationMs, playing, seekable, title]);

    useEffect(() => () => {
        if (!isCapacitorAndroid()) return;

        revisionRef.current += 1;
        void androidMediaSession
            .clear({ revision: revisionRef.current, sessionId: sessionIdRef.current ?? '' })
            .catch(error => {
                console.warn(`${logPrefix} Could not clear native media session`, error);
            });
    }, []);
}
