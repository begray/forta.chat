package com.forta.chat.plugins.backgroundupload

import android.Manifest
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

/**
 * JS bridge for [BackgroundUploadService], driven by
 * `src/shared/lib/background-transfer` (start / update / stop while media
 * sends are in progress). Events: `cancelAll` (the notification's Cancel),
 * `heartbeat` (every 15 s while running) and `stopped` (the service stopped
 * on its own: idle, timeout, start-failed, system).
 *
 * The notification permission (Android 13+) is asked by JS at the first big
 * send. Without it the service still runs; Android just hides the
 * notification (it stays visible in the task manager).
 */
@CapacitorPlugin(
    name = "BackgroundUpload",
    permissions = [Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS])],
)
class BackgroundUploadPlugin : Plugin() {

    private val serviceListener = object : BackgroundUploadService.Listener {
        override fun onCancelRequested() {
            notifyListeners("cancelAll", JSObject())
        }

        override fun onHeartbeat() {
            notifyListeners("heartbeat", JSObject())
        }

        override fun onStopped(reason: String) {
            notifyListeners("stopped", JSObject().apply { put("reason", reason) })
        }
    }

    override fun load() {
        BackgroundUploadService.listener = serviceListener
    }

    override fun handleOnDestroy() {
        // The activity, and with it the WebView doing the uploads, is gone:
        // nothing is left to keep alive.
        if (BackgroundUploadService.listener === serviceListener) {
            BackgroundUploadService.listener = null
            BackgroundUploadService.stop()
        }
        super.handleOnDestroy()
    }

    private fun noticeOf(call: PluginCall) = KeepAliveNotice(
        title = call.getString("title") ?: "",
        text = call.getString("text") ?: "",
        percent = call.getInt("percent") ?: 0,
        cancelLabel = call.getString("cancelLabel") ?: context.getString(android.R.string.cancel),
    )

    @PluginMethod
    fun start(call: PluginCall) {
        try {
            BackgroundUploadService.start(context, noticeOf(call))
            call.resolve()
        } catch (e: Exception) {
            // ForegroundServiceStartNotAllowedException / IllegalStateException
            call.reject("${e.javaClass.simpleName}: ${e.message}", "START_REFUSED", e)
        }
    }

    @PluginMethod
    fun update(call: PluginCall) {
        BackgroundUploadService.update(noticeOf(call))
        call.resolve()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        BackgroundUploadService.stop()
        call.resolve()
    }

    @PluginMethod
    fun notificationPermission(call: PluginCall) {
        call.resolve(JSObject().apply { put("state", notificationState()) })
    }

    @PluginMethod
    fun requestNotificationPermission(call: PluginCall) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || notificationState() != "prompt") {
            call.resolve(JSObject().apply { put("state", notificationState()) })
            return
        }
        requestPermissionForAlias("notifications", call, "notificationPermissionResult")
    }

    @PermissionCallback
    private fun notificationPermissionResult(call: PluginCall) {
        call.resolve(JSObject().apply { put("state", notificationState()) })
    }

    private fun notificationState(): String {
        val enabled = NotificationManagerCompat.from(context).areNotificationsEnabled()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return if (enabled) "granted" else "denied"
        return when (getPermissionState("notifications")) {
            PermissionState.GRANTED -> if (enabled) "granted" else "denied"
            PermissionState.DENIED -> "denied"
            else -> "prompt"
        }
    }
}
