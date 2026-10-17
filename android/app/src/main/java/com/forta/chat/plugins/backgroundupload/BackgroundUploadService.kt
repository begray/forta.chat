package com.forta.chat.plugins.backgroundupload

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.forta.chat.R

/**
 * Keep-alive foreground service for media sends ("Sending 3 of 12 · 40%").
 *
 * Like `AiInferenceForegroundService` it does no work of its own: the uploads
 * run in the WebView (XHR) or in `TorFilePlugin`, and video compression in
 * `VideoCompressPlugin`. Without it Android puts the backgrounded app into
 * Doze within minutes of the screen locking and its sockets die; the upload
 * then restarts from byte 0 on unlock. While this service runs the process
 * stays at foreground-service priority, which keeps its network access in
 * Doze, and a partial wake lock keeps the CPU running with the screen off.
 * See docs/background-uploads.md for why this is a `dataSync` service rather
 * than a user-initiated data transfer job.
 *
 * Lifecycle: JS (`shared/lib/background-transfer`) starts it while the app is
 * visible (Android 12+ refuses a background start), updates the notification
 * as the send queue moves, and stops it when the queue is empty. On its own it
 * stops when nothing moved for [KeepAliveState.IDLE_LIMIT_MS], when Android's
 * dataSync time limit runs out ([onTimeout], Android 15+), or when the
 * activity (and with it the WebView doing the uploads) is gone. The
 * notification's Cancel action is passed to JS, which cancels every send.
 */
class BackgroundUploadService : Service() {

    interface Listener {
        fun onCancelRequested()
        fun onHeartbeat()
        fun onStopped(reason: String)
    }

    companion object {
        private const val TAG = "BackgroundUploadService"
        private const val CHANNEL_ID = "media_upload"
        private const val NOTIFICATION_ID = 20003
        private const val WAKELOCK_TAG = "forta:media_upload"
        private const val WIFILOCK_TAG = "forta:media_upload_wifi"
        /** Auto-release of the wake lock, renewed on progress: a missed
         *  release can never hold the CPU much past the idle limit. */
        private const val WAKELOCK_TIMEOUT_MS = KeepAliveState.IDLE_LIMIT_MS + 5 * 60 * 1000L
        /** JS timers are throttled in a hidden page; this nudges the queue. */
        private const val HEARTBEAT_MS = 15_000L

        private const val ACTION_START = "com.forta.chat.MEDIA_UPLOAD_START"
        private const val ACTION_CANCEL = "com.forta.chat.MEDIA_UPLOAD_CANCEL"
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_TEXT = "text"
        private const val EXTRA_PERCENT = "percent"
        private const val EXTRA_CANCEL_LABEL = "cancelLabel"

        const val STOP_IDLE = "idle"
        const val STOP_TIMEOUT = "timeout"
        const val STOP_START_FAILED = "start-failed"
        const val STOP_SYSTEM = "system"

        /** Set by `BackgroundUploadPlugin.load()`. */
        @Volatile
        var listener: Listener? = null

        private val main = Handler(Looper.getMainLooper())

        // Main thread only.
        private var instance: BackgroundUploadService? = null
        private var startPending = false
        private var stopPending = false

        /** Throws when Android refuses the start (app not visible on
         *  Android 12+, dataSync time used up on Android 15+). */
        fun start(context: Context, notice: KeepAliveNotice) {
            val intent = Intent(context, BackgroundUploadService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_TITLE, notice.title)
                putExtra(EXTRA_TEXT, notice.text)
                putExtra(EXTRA_PERCENT, notice.percent)
                putExtra(EXTRA_CANCEL_LABEL, notice.cancelLabel)
            }
            ContextCompat.startForegroundService(context, intent)
            main.post {
                stopPending = false
                if (instance == null) startPending = true
            }
        }

        fun update(notice: KeepAliveNotice) {
            main.post { instance?.applyUpdate(notice) }
        }

        fun stop() {
            main.post {
                val running = instance
                if (running != null) running.finish(null)
                else if (startPending) stopPending = true
            }
        }
    }

    private val state = KeepAliveState()
    private var finished = false
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    private val tick = object : Runnable {
        override fun run() {
            if (finished) return
            if (state.isIdle(SystemClock.elapsedRealtime())) {
                Log.w(TAG, "no progress for ${KeepAliveState.IDLE_LIMIT_MS / 60000} min, stopping")
                finish(STOP_IDLE)
                return
            }
            listener?.onHeartbeat()
            main.postDelayed(this, HEARTBEAT_MS)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val notice = KeepAliveNotice(
                    title = intent.getStringExtra(EXTRA_TITLE) ?: "",
                    text = intent.getStringExtra(EXTRA_TEXT) ?: "",
                    percent = intent.getIntExtra(EXTRA_PERCENT, 0),
                    cancelLabel = intent.getStringExtra(EXTRA_CANCEL_LABEL) ?: getString(android.R.string.cancel),
                )
                startPending = false
                begin(notice)
                if (stopPending) {
                    // JS was done before the service came up. startForeground()
                    // had to run first: a started foreground service that never
                    // calls it crashes the app.
                    stopPending = false
                    finish(null)
                }
            }
            ACTION_CANCEL -> {
                val l = listener
                if (l != null) l.onCancelRequested() else finish(STOP_SYSTEM)
            }
        }
        return START_NOT_STICKY
    }

    private fun begin(notice: KeepAliveNotice) {
        val now = SystemClock.elapsedRealtime()
        if (instance === this && !finished) {
            applyUpdate(notice)
            return
        }
        finished = false
        instance = this
        state.start(notice, now)
        if (!startForegroundTyped(buildNotification(state.notice!!))) {
            finish(STOP_START_FAILED)
            return
        }
        acquireLocks()
        main.removeCallbacks(tick)
        main.postDelayed(tick, HEARTBEAT_MS)
    }

    private fun applyUpdate(notice: KeepAliveNotice) {
        if (finished) return
        if (!state.update(notice, SystemClock.elapsedRealtime())) return
        renewWakeLock()
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        runCatching { nm.notify(NOTIFICATION_ID, buildNotification(state.notice!!)) }
            .onFailure { Log.w(TAG, "notify failed", it) }
    }

    /** Stop. `reason` != null: stopped on our own, JS is told why. */
    private fun finish(reason: String?) {
        if (finished) return
        finished = true
        if (instance === this) instance = null
        main.removeCallbacks(tick)
        releaseLocks()
        runCatching { stopForeground(STOP_FOREGROUND_REMOVE) }
        stopSelf()
        if (reason != null) listener?.onStopped(reason)
    }

    /** Android 15+: the dataSync time limit (6 h per day across the app's
     *  dataSync services) ran out. stopSelf() must follow within seconds. */
    override fun onTimeout(startId: Int, fgsType: Int) {
        Log.w(TAG, "dataSync time limit reached, stopping")
        finish(STOP_TIMEOUT)
    }

    override fun onDestroy() {
        if (!finished) {
            finished = true
            main.removeCallbacks(tick)
            releaseLocks()
            listener?.onStopped(STOP_SYSTEM)
        }
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Swiped away: the plugin's handleOnDestroy stops us once the
        // activity (and the WebView doing the uploads) is gone.
        super.onTaskRemoved(rootIntent)
    }

    private fun startForegroundTyped(notification: Notification): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            try {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
                return true
            } catch (e: Throwable) {
                // ForegroundServiceStartNotAllowedException (not visible any
                // more, or the dataSync time is used up) lands here too.
                Log.e(TAG, "startForeground(dataSync) refused", e)
                return false
            }
        }
        return try {
            startForeground(NOTIFICATION_ID, notification)
            true
        } catch (e: Throwable) {
            Log.e(TAG, "startForeground refused", e)
            false
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.channel_media_upload),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.channel_media_upload_desc)
            setSound(null, null)
            enableVibration(false)
            setShowBadge(false)
        }
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(channel)
    }

    private fun buildNotification(notice: KeepAliveNotice): Notification {
        val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, 0, it, flags)
        }
        val cancel = PendingIntent.getService(
            this,
            1,
            Intent(this, BackgroundUploadService::class.java).setAction(ACTION_CANCEL),
            flags,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle(notice.title)
            .setContentText(notice.text)
            .setProgress(100, notice.percent, false)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setContentIntent(open)
            .addAction(0, notice.cancelLabel, cancel)
            .build()
    }

    // Partial wake lock: the CPU keeps running with the screen off (the
    // service alone keeps the process, not the CPU). Wi-Fi lock: keeps Wi-Fi
    // out of power save; Android 14 deprecated the only mode that applies
    // with the screen off, so it is only taken below that.
    @SuppressLint("WakelockTimeout")
    private fun acquireLocks() {
        if (wakeLock == null) {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKELOCK_TAG).apply {
                setReferenceCounted(false)
                acquire(WAKELOCK_TIMEOUT_MS)
            }
        }
        if (wifiLock == null && Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            runCatching {
                val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
                @Suppress("DEPRECATION")
                wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, WIFILOCK_TAG).apply {
                    setReferenceCounted(false)
                    acquire()
                }
            }.onFailure { Log.w(TAG, "Wi-Fi lock unavailable", it) }
        }
    }

    private fun renewWakeLock() {
        wakeLock?.let { if (it.isHeld) it.acquire(WAKELOCK_TIMEOUT_MS) }
    }

    private fun releaseLocks() {
        wakeLock?.let { if (it.isHeld) runCatching { it.release() } }
        wakeLock = null
        wifiLock?.let { if (it.isHeld) runCatching { it.release() } }
        wifiLock = null
    }
}
