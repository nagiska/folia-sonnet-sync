import { useEffect, useRef } from 'react';
import { androidMediaSession } from '../platform/androidMediaSession';
import type {
    AndroidMediaSessionAction,
    AndroidMediaSessionLabels,
} from '../platform/androidMediaSession';
import { isCapacitorAndroid } from '../platform/runtime';

// 当前文件：把 Folia 的曲目与播放状态同步到 Android 系统媒体会话，并转发通知按钮。
//
// State flows one way: this hook publishes metadata and playback state. Commands flow the other
// way: native action events call the App's latest callbacks, so a notification press runs the same
// path as an on-screen control. Actions can only be handled while this WebView is alive and the
// listener is registered; killing the WebView leaves neither the session owner nor a command target.

export type UseAndroidMediaSessionBridgeOptions = {
    title: string | null;
    artist: string | null;
    album: string | null;
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

const createSessionId = (): string => (
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
);

export function useAndroidMediaSessionBridge({
    title,
    artist,
    album,
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

    useEffect(() => {
        canLikeRef.current = canLike;
    }, [canLike]);

    useEffect(() => {
        controlsDisabledRef.current = controlsDisabled;
    }, [controlsDisabled]);

    useEffect(() => {
        labelsRef.current = labels;
    }, [labels]);

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

        const handleAction = (action: AndroidMediaSessionAction) => {
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
                ) {
                    handleAction(action);
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
        const nextRevision = revisionRef.current + 1;
        revisionRef.current = nextRevision;

        // Empty metadata is a normal state: clear the session instead of rejecting a sync call.
        const request = trimmedTitle
            ? androidMediaSession.sync({
                revision: nextRevision,
                sessionId,
                title: trimmedTitle,
                artist: artist ?? '',
                album: album ?? '',
                canLike,
                isLiked,
                playing,
                labels: labelsRef.current,
            })
            : androidMediaSession.clear({ revision: nextRevision, sessionId });

        void request.catch(error => {
            console.warn(`${logPrefix} Could not sync native media session`, error);
        });
    }, [album, artist, canLike, isLiked, labelsKey, playing, title]);

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
