package com.forta.chat.plugins.backgroundupload

/** What the ongoing notification shows; composed (and translated) in JS. */
data class KeepAliveNotice(
    val title: String,
    val text: String,
    val percent: Int,
    val cancelLabel: String,
) {
    fun clamped(): KeepAliveNotice = copy(percent = percent.coerceIn(0, 100))
}

/**
 * The keep-alive's bookkeeping, free of Android types so it can be unit
 * tested: the notice on screen, and when the service gives up on its own.
 *
 * Any change of the notice counts as progress (a new percent, the next item,
 * compressing -> uploading). The same notice again does not: JS keeps sending
 * updates while an upload is stuck, and those must not keep the wake lock
 * forever. After [idleLimitMs] without progress the service stops; the
 * uploads then fall back to the restart on unlock.
 */
class KeepAliveState(private val idleLimitMs: Long = IDLE_LIMIT_MS) {

    var notice: KeepAliveNotice? = null
        private set

    private var lastProgressAt = 0L

    fun start(next: KeepAliveNotice, now: Long) {
        notice = next.clamped()
        lastProgressAt = now
    }

    /** Applies an update; true when the notification has to be redrawn
     *  (that is, when there was progress). */
    fun update(next: KeepAliveNotice, now: Long): Boolean {
        val clamped = next.clamped()
        if (clamped == notice) return false
        notice = clamped
        lastProgressAt = now
        return true
    }

    fun isIdle(now: Long): Boolean = notice != null && now - lastProgressAt >= idleLimitMs

    companion object {
        /** No progress for this long: stop (nothing is moving anyway). */
        const val IDLE_LIMIT_MS = 30 * 60 * 1000L
    }
}
