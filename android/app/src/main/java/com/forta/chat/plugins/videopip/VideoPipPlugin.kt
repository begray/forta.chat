package com.forta.chat.plugins.videopip

import android.app.PictureInPictureParams
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import android.util.Rational
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Picture-in-picture for post videos (Video.js player in the WebView).
 *
 * Android WebView has no working web PiP API, so the JS side
 * (`src/shared/lib/video-js/android-pip.ts`) backs `requestPictureInPicture`
 * with [enter]: the page first makes the player cover the viewport, then the
 * whole MainActivity goes into PiP. Leaving PiP is reported back through the
 * `pipChanged` event from [MainActivity.onPictureInPictureModeChanged].
 *
 * Entering is button-only (owner decision 2026-10-13): no auto-enter when the
 * user leaves the app.
 */
@CapacitorPlugin(name = "VideoPip")
class VideoPipPlugin : Plugin() {

    companion object {
        private const val TAG = "VideoPip"
    }

    private fun isPipSupported(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            context.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

    @PluginMethod
    fun isSupported(call: PluginCall) {
        call.resolve(JSObject().put("supported", isPipSupported()))
    }

    @PluginMethod
    fun enter(call: PluginCall) {
        if (!isPipSupported() || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            call.resolve(JSObject().put("entered", false))
            return
        }
        val (num, den) = PipAspectRatio.forVideo(
            call.getInt("width") ?: 0,
            call.getInt("height") ?: 0,
        )
        activity.runOnUiThread {
            val entered = try {
                val params = PictureInPictureParams.Builder()
                    .setAspectRatio(Rational(num, den))
                    .build()
                activity.enterPictureInPictureMode(params)
            } catch (e: IllegalStateException) {
                // PiP disabled for the app in system settings, or the activity
                // is not resumed.
                Log.w(TAG, "enterPictureInPictureMode refused", e)
                false
            } catch (e: IllegalArgumentException) {
                Log.w(TAG, "PiP params rejected ($num:$den)", e)
                false
            }
            call.resolve(JSObject().put("entered", entered))
        }
    }

    /**
     * Called by MainActivity when the activity enters or leaves PiP.
     * [dismissed]: the user closed the window rather than expanding it.
     */
    fun onPipModeChanged(active: Boolean, dismissed: Boolean) {
        notifyListeners(
            "pipChanged",
            JSObject().put("active", active).put("dismissed", dismissed),
        )
    }
}
