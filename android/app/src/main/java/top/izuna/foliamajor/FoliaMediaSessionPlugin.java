package top.izuna.foliamajor;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioAttributes;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import androidx.core.content.ContextCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// 当前文件：Android 系统媒体会话与媒体通知桥接；曲目、封面、播放进度和按钮文案由 WebView 同步。
@CapacitorPlugin(name = "FoliaMediaSession")
public class FoliaMediaSessionPlugin extends Plugin {
    private static final String TAG = "FoliaMediaSession";
    private static final String CHANNEL_ID = "folia_media_session";
    private static final int NOTIFICATION_ID = 0x0F01A;
    /** The media card draws the cover small; a bigger bitmap only costs binder traffic. */
    private static final int ARTWORK_MAX_PX = 512;
    private static final int ARTWORK_MAX_BYTES = 8 * 1024 * 1024;
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

    // Everything the metadata and playback state are rebuilt from. Progress ticks rewrite only the
    // playback state, so the cover is kept here instead of being re-sent from the WebView.
    private String trackTitle = "";
    private String trackArtist = "";
    private String trackAlbum = "";
    private long trackDurationMs;
    private long trackPositionMs;
    private boolean trackPlaying;
    private boolean trackSeekable;
    private boolean trackCanLike;
    private boolean trackIsLiked;
    private Labels trackLabels = Labels.from(null, "Folia");
    private String artworkSource = "";
    private Bitmap artwork;
    // Covers arrive as bytes: decoding a bitmap on the main thread would block the notification.
    private final ExecutorService artworkLoader = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "FoliaArtwork");
        thread.setDaemon(true);
        return thread;
    });

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
        String artworkUrl = stringValue(data, "artworkUrl", "").trim();
        long durationMs = data.optLong("durationMs", 0);
        long positionMs = data.optLong("positionMs", 0);
        boolean seekable = data.optBoolean("seekable", false);
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
                applyTrack(
                    title, artist, album, artworkUrl, durationMs, positionMs, seekable,
                    playing, canLike, isLiked, labels
                );
                call.resolve();
            } catch (RuntimeException e) {
                Log.w(TAG, "Could not update the media session", e);
                call.reject("Could not update the media session", e);
            }
        });
    }

    // The position moves continuously and the WebView owns the clock, so it corrects the session
    // periodically instead of the metadata being republished on every tick.
    @PluginMethod
    public void progress(PluginCall call) {
        JSObject data = call.getData();
        if (data == null) {
            data = new JSObject();
        }
        String title = stringValue(data, "title", "").trim();
        long positionMs = data.optLong("positionMs", 0);
        long durationMs = data.optLong("durationMs", 0);
        boolean playing = data.optBoolean("playing", false);
        boolean seekable = data.optBoolean("seekable", false);

        if (getBridge() == null) {
            call.resolve();
            return;
        }
        getBridge().executeOnMainThread(() -> {
            // A tick that left the WebView before the track changed would move the bar of the track
            // that replaced it. It takes no revision: a progress write must never drop a pending
            // sync, which is the call that carries the cover.
            if (mediaSession == null || !title.equals(trackTitle)) {
                call.resolve();
                return;
            }
            try {
                long nextDuration = Math.max(0, durationMs);
                boolean durationChanged = nextDuration != trackDurationMs;
                trackPositionMs = Math.max(0, positionMs);
                trackDurationMs = nextDuration;
                trackPlaying = playing;
                trackSeekable = seekable;
                // The length lives in the metadata; a track that reported it after the first sync
                // gets exactly one more metadata write, and its cover is still in hand.
                if (durationChanged) {
                    mediaSession.setMetadata(buildMetadata());
                }
                mediaSession.setPlaybackState(buildPlaybackState());
                call.resolve();
            } catch (RuntimeException e) {
                Log.w(TAG, "Could not update the media session progress", e);
                call.reject("Could not update the media session progress", e);
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
        String artworkUrl,
        long durationMs,
        long positionMs,
        boolean seekable,
        boolean playing,
        boolean canLike,
        boolean isLiked,
        Labels labels
    ) {
        Context context = getContext();
        MediaSession session = ensureSession(context);

        trackTitle = title;
        trackArtist = artist;
        trackAlbum = album;
        trackDurationMs = Math.max(0, durationMs);
        trackPositionMs = Math.max(0, positionMs);
        trackSeekable = seekable;
        trackPlaying = playing;
        trackCanLike = canLike;
        trackIsLiked = isLiked;
        trackLabels = labels;

        session.setMetadata(buildMetadata());
        session.setPlaybackState(buildPlaybackState());

        ensureChannel(context, labels.applicationName);
        postNotification(context);
        loadArtwork(artworkUrl);
    }

    private MediaMetadata buildMetadata() {
        MediaMetadata.Builder builder = new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, trackTitle)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, trackArtist)
            .putString(MediaMetadata.METADATA_KEY_ALBUM, trackAlbum);
        if (trackDurationMs > 0) {
            builder.putLong(MediaMetadata.METADATA_KEY_DURATION, trackDurationMs);
        }
        if (artwork != null) {
            builder.putBitmap(MediaMetadata.METADATA_KEY_ART, artwork);
        }
        return builder.build();
    }

    private MediaSession ensureSession(Context context) {
        if (mediaSession != null) {
            return mediaSession;
        }
        mediaSession = new MediaSession(context, TAG);
        mediaSession.setFlags(
            MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS
        );
        mediaSession.setPlaybackToLocal(new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
            .build());
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
            public void onSeekTo(long positionMs) {
                emitSeek(positionMs);
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

    private PlaybackState buildPlaybackState() {
        long actions = PlaybackState.ACTION_PLAY
            | PlaybackState.ACTION_PAUSE
            | PlaybackState.ACTION_PLAY_PAUSE
            | PlaybackState.ACTION_SKIP_TO_PREVIOUS
            | PlaybackState.ACTION_SKIP_TO_NEXT;
        if (trackSeekable && trackDurationMs > 0) {
            actions |= PlaybackState.ACTION_SEEK_TO;
        }
        // Position and length are the WebView's, reported at publish time; a playing state is what
        // lets the system panel advance the bar in between.
        PlaybackState.Builder builder = new PlaybackState.Builder()
            .setActions(actions)
            .setState(
                trackPlaying ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                trackPositionMs,
                trackPlaying ? 1f : 0f
            );
        if (trackCanLike) {
            PlaybackState.CustomAction likeAction = new PlaybackState.CustomAction.Builder(
                CUSTOM_ACTION_LIKE,
                trackIsLiked ? trackLabels.unlike : trackLabels.like,
                trackIsLiked ? R.drawable.ic_media_heart : R.drawable.ic_media_heart_outline
            ).build();
            builder.addCustomAction(likeAction);
        }
        return builder.build();
    }

    private void postNotification(Context context) {
        if (mediaSession == null) {
            return;
        }
        Notification notification = buildNotification(context, mediaSession);
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

    private Notification buildNotification(Context context, MediaSession session) {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(context, CHANNEL_ID)
            : new Notification.Builder(context);
        builder.setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(trackTitle)
            .setContentText(trackArtist)
            .setContentIntent(activityIntent(context))
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setCategory(Notification.CATEGORY_TRANSPORT)
            .setShowWhen(false)
            .setOnlyAlertOnce(true)
            .setOngoing(trackPlaying)
            .addAction(
                android.R.drawable.ic_media_previous,
                trackLabels.previous,
                broadcast(context, INTENT_PREVIOUS, 1)
            )
            .addAction(
                trackPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                trackPlaying ? trackLabels.pause : trackLabels.play,
                trackPlaying ? broadcast(context, INTENT_PAUSE, 2) : broadcast(context, INTENT_PLAY, 3)
            )
            .addAction(
                android.R.drawable.ic_media_next,
                trackLabels.next,
                broadcast(context, INTENT_NEXT, 4)
            )
            .setStyle(new Notification.MediaStyle()
                .setMediaSession(session.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2));
        if (trackCanLike) {
            builder.addAction(
                trackIsLiked ? R.drawable.ic_media_heart : R.drawable.ic_media_heart_outline,
                trackIsLiked ? trackLabels.unlike : trackLabels.like,
                broadcast(context, INTENT_LIKE, 5)
            );
        }
        if (artwork != null) {
            builder.setLargeIcon(artwork);
        }
        if (!trackAlbum.isEmpty()) {
            builder.setSubText(trackAlbum);
        }
        return builder.build();
    }

    // Reads one cover at a time off the main thread and drops a result the track has already left.
    private void loadArtwork(String artworkUrl) {
        String next = artworkUrl == null ? "" : artworkUrl.trim();
        if (next.equals(artworkSource)) {
            return;
        }
        artworkSource = next;
        artwork = null;
        if (next.isEmpty()) {
            return;
        }
        final Bridge bridge = getBridge();
        if (bridge == null) {
            return;
        }
        final String requested = next;
        artworkLoader.execute(() -> {
            Bitmap decoded = decodeArtwork(requested);
            if (decoded == null) {
                return;
            }
            bridge.executeOnMainThread(() -> {
                // The track may have changed while the bytes were in flight.
                if (!requested.equals(artworkSource) || mediaSession == null) {
                    return;
                }
                artwork = decoded;
                mediaSession.setMetadata(buildMetadata());
                Context current = getContext();
                if (current != null) {
                    postNotification(current);
                }
            });
        });
    }

    private static Bitmap decodeArtwork(String source) {
        try {
            byte[] bytes;
            if (source.startsWith("data:")) {
                int comma = source.indexOf(',');
                if (comma < 0 || comma == source.length() - 1) {
                    return null;
                }
                bytes = Base64.decode(source.substring(comma + 1), Base64.DEFAULT);
            } else if (source.startsWith("http://") || source.startsWith("https://")) {
                bytes = downloadArtwork(source);
            } else {
                // blob: and app-local URLs only exist inside the WebView; the WebView sends bytes.
                return null;
            }
            if (bytes == null || bytes.length == 0) {
                return null;
            }
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inSampleSize = sampleSize(Math.max(bounds.outWidth, bounds.outHeight), ARTWORK_MAX_PX);
            Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
            if (bitmap == null) {
                return null;
            }
            int longest = Math.max(bitmap.getWidth(), bitmap.getHeight());
            if (longest > ARTWORK_MAX_PX) {
                float scale = (float) ARTWORK_MAX_PX / (float) longest;
                Bitmap scaled = Bitmap.createScaledBitmap(
                    bitmap,
                    Math.max(1, Math.round(bitmap.getWidth() * scale)),
                    Math.max(1, Math.round(bitmap.getHeight() * scale)),
                    true
                );
                if (scaled != bitmap) {
                    bitmap.recycle();
                }
                return scaled;
            }
            return bitmap;
        } catch (Exception e) {
            Log.w(TAG, "Could not decode the media artwork", e);
            return null;
        }
    }

    private static byte[] downloadArtwork(String source) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(source).openConnection();
        connection.setConnectTimeout(8000);
        connection.setReadTimeout(8000);
        connection.setInstanceFollowRedirects(true);
        try {
            InputStream input = connection.getInputStream();
            try {
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                int read;
                while ((read = input.read(buffer)) != -1) {
                    output.write(buffer, 0, read);
                    if (output.size() > ARTWORK_MAX_BYTES) {
                        return null;
                    }
                }
                return output.toByteArray();
            } finally {
                input.close();
            }
        } finally {
            connection.disconnect();
        }
    }

    private static int sampleSize(int longest, int maxPx) {
        int size = 1;
        while (longest / size > maxPx) {
            size *= 2;
        }
        return size;
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
        trackTitle = "";
        trackArtist = "";
        trackAlbum = "";
        trackDurationMs = 0;
        trackPositionMs = 0;
        trackPlaying = false;
        trackSeekable = false;
        trackCanLike = false;
        trackIsLiked = false;
        artworkSource = "";
        artwork = null;
    }

    private void emitAction(String action) {
        JSObject payload = new JSObject();
        payload.put("action", action);
        notifyListeners("action", payload);
    }

    private void emitSeek(long positionMs) {
        JSObject payload = new JSObject();
        payload.put("action", "seek");
        payload.put("positionMs", positionMs);
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
