package com.forta.chat.plugins.push

import android.content.Context

/**
 * Whether a push came through this build's own Firebase project.
 *
 * Moving to a new Firebase project (2026-10, `fortachat`, app_id
 * `fortaandroid2`) leaves the old pusher (`fortaandroid`, old project) on the
 * homeserver with a token that still works, so every message would arrive
 * twice: two sounds, two vibrations. `RemoteMessage.from` names the sending
 * project, and a push from any other project is dropped.
 *
 * Only once this device's own pusher is live: an update that the user has not
 * opened yet has no new pusher, and the old one is its only delivery path.
 * Anything unknown (no sender, no Firebase options) is delivered: a duplicate
 * is better than a lost message.
 */
object PushSenderPolicy {

    fun shouldDeliver(from: String?, ownSenderIds: List<String?>, isOwnPusherLive: Boolean): Boolean {
        if (!isOwnPusherLive || from.isNullOrBlank()) return true
        val own = ownSenderIds.filterNotNull().filter { it.isNotBlank() }
        return own.isEmpty() || from in own
    }

    /**
     * The token whose pusher JS has to remove after an FCM token rotation.
     * The oldest one not removed yet wins: two rotations before JS runs must
     * not lose the old-project token behind an intermediate one.
     */
    fun legacyTokenAfterRotation(previous: String?, current: String, pendingLegacy: String?): String? = when {
        !pendingLegacy.isNullOrBlank() -> pendingLegacy
        previous.isNullOrBlank() || previous == current -> null
        else -> previous
    }
}

/** FCM tokens behind [PushSenderPolicy], kept where a cold-started FCM service can read them. */
object PushTokenStore {
    /** Shared with FortaFirebaseMessagingService, which has written `fcm_token` since 2026-03. */
    private const val PREFS = "forta_push"
    private const val KEY_TOKEN = "fcm_token"
    private const val KEY_LEGACY = "fcm_token_legacy"
    private const val KEY_REGISTERED = "fcm_token_registered"

    fun onNewToken(context: Context, token: String) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val legacy = PushSenderPolicy.legacyTokenAfterRotation(
            prefs.getString(KEY_TOKEN, null), token, prefs.getString(KEY_LEGACY, null),
        )
        prefs.edit()
            .putString(KEY_TOKEN, token)
            .putString(KEY_LEGACY, legacy)
            .apply()
    }

    /**
     * JS registered the pusher for [token]; returns the legacy token whose
     * pusher to remove, if any. JS holds the current token, so a stored token
     * that differs is a rotation too, even one [onNewToken] never saw.
     */
    fun markRegistered(context: Context, token: String): String? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val legacy = PushSenderPolicy.legacyTokenAfterRotation(
            prefs.getString(KEY_TOKEN, null), token, prefs.getString(KEY_LEGACY, null),
        )?.takeIf { it != token }
        prefs.edit()
            .putString(KEY_TOKEN, token)
            .putString(KEY_REGISTERED, token)
            .putString(KEY_LEGACY, legacy)
            .apply()
        return legacy
    }

    /** Clears the legacy token only if it is still [token]: a newer rotation keeps its own. */
    fun clearLegacy(context: Context, token: String) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (prefs.getString(KEY_LEGACY, null) == token) {
            prefs.edit().remove(KEY_LEGACY).apply()
        }
    }

    fun isOwnPusherLive(context: Context): Boolean {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val registered = prefs.getString(KEY_REGISTERED, null)
        return registered != null && registered == prefs.getString(KEY_TOKEN, null)
    }
}
