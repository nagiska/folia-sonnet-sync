package top.izuna.foliamajor;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.drawable.Icon;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;

import org.json.JSONObject;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// 当前文件：Android 系统媒体会话与媒体通知桥接；曲目、播放状态和按钮文案由 WebView 同步。
@CapacitorPlugin(name = "FoliaMediaSession")
public class FoliaMediaSessionPlugin extends Plugin {
    private static final String TAG = "FoliaMediaSession";
    private static final String CHANNEL_ID = "folia_media_session";
    private static final int NOTIFICATION_ID = 0x0F01A;
    private static final String INTENT_PLAY = "top.izuna.foliamajor.media.PLAY";
    private static final String INTENT_PAUSE = "top.izuna.foliamajor.media.PAUSE";
    private static final String INTENT_PREVIOUS = "top.izuna.foliamajor.media.PREVIOUS";
    private static final String INTENT_NEXT = "top.izuna.foliamajor.media.NEXT";
    private static final String INTENT_LIKE = "top.izuna.foliamajor.media.LIKE";
    private static final String CUSTOM_ACTION_LIKE = "top.izuna.foliamajor.media.CUSTOM_LIKE";

    private MediaSession mediaSession;
    private boolean receiverRegistered;
    private int lastRevision = Integer.MIN_VALUE;
    private String lastSessionId = "";

    // Notification actions target this dynamically registered receiver; it forwards them to the
    // MediaSession callback so notification buttons and system media buttons share one path.
    private final BroadcastReceiver actionReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (mediaSession == null || intent.getAction() == null) {
                return;
            }
            MediaController.TransportControls controls = mediaSession.getController().getTransportControls();
            switch (intent.getAction()) {
                case INTENT_PLAY:
                    controls.play();
                    break;
                case INTENT_PAUSE:
                    controls.pause();
                    break;
                case INTENT_PREVIOUS:
                    controls.skipToPrevious();
                    break;
                case INTENT_NEXT:
                    controls.skipToNext();
                    break;
                case INTENT_LIKE:
                    controls.sendCustomAction(CUSTOM_ACTION_LIKE, null);
                    break;
                default:
                    break;
            }
        }
    };

    @PluginMethod
    public void sync(PluginCall call) {
        JSObject data = call.getData();
        if (data == null) {
            data = new JSObject();
        }
        int revision = data.optInt("revision", 0);
        String sessionId = stringValue(data, "sessionId", "");
        String title = stringValue(data, "title", "").trim();
        if (title.isEmpty()) {
            // An empty track is a normal state, not an error: clean up and resolve.
            clearInternal(call, sessionId, revision);
            return;
        }
        String artist = stringValue(data, "artist", "").trim();
        String album = stringValue(data, "album", "").trim();
        boolean playing = data.optBoolean("playing", false);
        boolean canLike = data.optBoolean("canLike", false);
        boolean isLiked = data.optBoolean("isLiked", false);
        Labels labels = Labels.from(data.optJSONObject("labels"), fallbackApplicationName());

        if (getBridge() == null) {
            releaseSession();
            call.resolve();
            return;
        }
        getBridge().executeOnMainThread(() -> {
            if (!acceptRevision(sessionId, revision)) {
                call.resolve();
                return;
            }
            try {
                applyTrack(title, artist, album, playing, canLike, isLiked, labels);
                call.resolve();
            } catch (RuntimeException e) {
                Log.w(TAG, "Could not update the media session", e);
                call.reject("Could not update the media session", e);
            }
        });
    }

    @PluginMethod
    public void clear(PluginCall call) {
        JSObject data = call.getData();
        int revision = data != null ? data.optInt("revision", 0) : 0;
        String sessionId = data != null ? stringValue(data, "sessionId", "") : "";
        clearInternal(call, sessionId, revision);
    }

    private void clearInternal(PluginCall call, String sessionId, int revision) {
        if (getBridge() == null) {
            releaseSession();
            call.resolve();
            return;
        }
        getBridge().executeOnMainThread(() -> {
            if (!acceptRevision(sessionId, revision)) {
                call.resolve();
                return;
            }
            releaseSession();
            call.resolve();
        });
    }

    // Revisions prevent a late sync from reviving a notification that a newer clear removed.
    // A new WebView session resets the counter because its revisions start over.
    private boolean acceptRevision(String sessionId, int revision) {
        if (!sessionId.equals(lastSessionId)) {
            lastSessionId = sessionId;
            lastRevision = Integer.MIN_VALUE;
        }
        if (revision < lastRevision) {
            return false;
        }
        lastRevision = revision;
        return true;
    }

    private void applyTrack(
        String title,
        String artist,
        String album,
        boolean playing,
        boolean canLike,
        boolean isLiked,
        Labels labels
    ) {
        Context context = getContext();
        MediaSession session = ensureSession(context);

        // Artwork is deliberately omitted: fetching a cover here would block the main thread.
        MediaMetadata metadata = new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, title)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
            .putString(MediaMetadata.METADATA_KEY_ALBUM, album)
            .build();
        session.setMetadata(metadata);
        session.setPlaybackState(buildPlaybackState(context, playing, canLike, isLiked, labels));

        ensureChannel(context, labels.applicationName);
        Notification notification = buildNotification(
            context, session, title, artist, album, playing, canLike, isLiked, labels
        );
        try {
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) {
                // MediaStyle notifications are exempt from the Android 13 notification permission,
                // so no runtime permission is requested; a rejection only skips the notification.
                manager.notify(NOTIFICATION_ID, notification);
            }
        } catch (SecurityException e) {
            Log.w(TAG, "Media notification was rejected; the media session stays active", e);
        }
    }

    private MediaSession ensureSession(Context context) {
        if (mediaSession != null) {
            return mediaSession;
        }
        mediaSession = new MediaSession(context, TAG);
        mediaSession.setFlags(
            MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS
        );
        mediaSession.setPlaybackToLocal(AudioManager.STREAM_MUSIC);
        mediaSession.setSessionActivity(activityIntent(context));
        mediaSession.setCallback(new MediaSession.Callback() {
            @Override
            public void onPlay() {
                emitAction("play");
            }

            @Override
            public void onPause() {
                emitAction("pause");
            }

            @Override
            public void onSkipToPrevious() {
                emitAction("previous");
            }

            @Override
            public void onSkipToNext() {
                emitAction("next");
            }

            @Override
            public void onCustomAction(String action, Bundle extras) {
                if (CUSTOM_ACTION_LIKE.equals(action)) {
                    emitAction("like");
                }
            }
        });
        mediaSession.setActive(true);
        registerActionReceiver(context);
        return mediaSession;
    }

    private PlaybackState buildPlaybackState(
        Context context,
        boolean playing,
        boolean canLike,
        boolean isLiked,
        Labels labels
    ) {
        long actions = PlaybackState.ACTION_PLAY
            | PlaybackState.ACTION_PAUSE
            | PlaybackState.ACTION_PLAY_PAUSE
            | PlaybackState.ACTION_SKIP_TO_PREVIOUS
            | PlaybackState.ACTION_SKIP_TO_NEXT;
        PlaybackState.Builder builder = new PlaybackState.Builder()
            .setActions(actions)
            // The WebView owns the real clock, so no position or duration is invented here.
            .setState(
                playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                PlaybackState.PLAYBACK_POSITION_UNKNOWN,
                playing ? 1f : 0f
            );
        if (canLike) {
            PlaybackState.CustomAction likeAction = new PlaybackState.CustomAction.Builder(
                CUSTOM_ACTION_LIKE,
                isLiked ? labels.unlike : labels.like,
                Icon.createWithResource(
                    context,
                    isLiked ? R.drawable.ic_media_heart : R.drawable.ic_media_heart_outline
                )
            ).build();
            builder.addCustomAction(likeAction);
        }
        return builder.build();
    }

    private Notification buildNotification(
        Context context,
        MediaSession session,
        String title,
        String artist,
        String album,
        boolean playing,
        boolean canLike,
        boolean isLiked,
        Labels labels
    ) {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(context, CHANNEL_ID)
            : new Notification.Builder(context);
        builder.setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(title)
            .setContentText(artist)
            .setContentIntent(activityIntent(context))
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setCategory(Notification.CATEGORY_TRANSPORT)
            .setShowWhen(false)
            .setOnlyAlertOnce(true)
            .setOngoing(playing)
            .addAction(
                android.R.drawable.ic_media_previous,
                labels.previous,
                broadcast(context, INTENT_PREVIOUS, 1)
            )
            .addAction(
                playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                playing ? labels.pause : labels.play,
                playing ? broadcast(context, INTENT_PAUSE, 2) : broadcast(context, INTENT_PLAY, 3)
            )
            .addAction(
                android.R.drawable.ic_media_next,
                labels.next,
                broadcast(context, INTENT_NEXT, 4)
            )
            .setStyle(new Notification.MediaStyle()
                .setMediaSession(session.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2));
        if (canLike) {
            builder.addAction(
                isLiked ? R.drawable.ic_media_heart : R.drawable.ic_media_heart_outline,
                isLiked ? labels.unlike : labels.like,
                broadcast(context, INTENT_LIKE, 5)
            );
        }
        if (!album.isEmpty()) {
            builder.setSubText(album);
        }
        return builder.build();
    }

    private static void ensureChannel(Context context, String applicationName) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID, applicationName, NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription(applicationName);
        channel.setShowBadge(false);
        channel.setSound(null, null);
        channel.enableVibration(false);
        manager.createNotificationChannel(channel);
    }

    private void registerActionReceiver(Context context) {
        if (receiverRegistered) {
            return;
        }
        IntentFilter filter = new IntentFilter();
        filter.addAction(INTENT_PLAY);
        filter.addAction(INTENT_PAUSE);
        filter.addAction(INTENT_PREVIOUS);
        filter.addAction(INTENT_NEXT);
        filter.addAction(INTENT_LIKE);
        try {
            ContextCompat.registerReceiver(
                context, actionReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED
            );
            receiverRegistered = true;
        } catch (RuntimeException e) {
            Log.w(TAG, "Could not register the media action receiver", e);
        }
    }

    private void releaseSession() {
        Context context = getContext();
        if (receiverRegistered && context != null) {
            try {
                context.unregisterReceiver(actionReceiver);
            } catch (IllegalArgumentException e) {
                Log.w(TAG, "Media action receiver was already unregistered", e);
            }
            receiverRegistered = false;
        }
        if (context != null) {
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) {
                manager.cancel(NOTIFICATION_ID);
            }
        }
        if (mediaSession != null) {
            mediaSession.setActive(false);
            mediaSession.release();
            mediaSession = null;
        }
    }

    private void emitAction(String action) {
        JSObject payload = new JSObject();
        payload.put("action", action);
        notifyListeners("action", payload);
    }

    private PendingIntent activityIntent(Context context) {
        Intent intent = new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(context, 0, intent, pendingIntentFlags());
    }

    private static PendingIntent broadcast(Context context, String action, int requestCode) {
        Intent intent = new Intent(action).setPackage(context.getPackageName());
        return PendingIntent.getBroadcast(context, requestCode, intent, pendingIntentFlags());
    }

    private static int pendingIntentFlags() {
        return PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
    }

    private String fallbackApplicationName() {
        Context context = getContext();
        if (context != null) {
            CharSequence label = context.getApplicationInfo().loadLabel(context.getPackageManager());
            if (label != null && label.length() > 0) {
                return label.toString();
            }
        }
        return "Folia";
    }

    private static String stringValue(JSObject data, String key, String fallback) {
        String value = data.optString(key, fallback);
        return value == null ? fallback : value;
    }

    @Override
    public void handleOnDestroy() {
        // The activity lifecycle may end while a notification is visible; drop both together.
        releaseSession();
        super.handleOnDestroy();
    }

    private static final class Labels {
        final String play;
        final String pause;
        final String previous;
        final String next;
        final String like;
        final String unlike;
        final String applicationName;

        private Labels(
            String play,
            String pause,
            String previous,
            String next,
            String like,
            String unlike,
            String applicationName
        ) {
            this.play = play;
            this.pause = pause;
            this.previous = previous;
            this.next = next;
            this.like = like;
            this.unlike = unlike;
            this.applicationName = applicationName;
        }

        static Labels from(JSONObject source, String fallbackApplicationName) {
            return new Labels(
                label(source, "play", "Play"),
                label(source, "pause", "Pause"),
                label(source, "previous", "Previous track"),
                label(source, "next", "Next track"),
                label(source, "like", "Like"),
                label(source, "unlike", "Unlike"),
                label(source, "applicationName", fallbackApplicationName)
            );
        }

        private static String label(JSONObject source, String key, String fallback) {
            if (source == null) {
                return fallback;
            }
            String value = source.optString(key, fallback);
            return value == null || value.trim().isEmpty() ? fallback : value;
        }
    }
}
