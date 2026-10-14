package com.forta.chat.plugins.videopip

/**
 * Aspect ratio for the video PiP window.
 *
 * Android rejects `PictureInPictureParams` whose ratio lies outside
 * 1:2.39 … 2.39:1 with an IllegalArgumentException, and a tall phone video
 * (9:16 is fine, 9:21 is not) or bad metadata would crash the request. Clamp
 * into the allowed range; fall back to 16:9 when the size is unknown.
 */
object PipAspectRatio {

    private const val MAX_RATIO = 2.39
    private const val MIN_RATIO = 1 / MAX_RATIO

    /** Integer precision of the clamped ratio (numerator/denominator scale). */
    private const val SCALE = 1000

    /** @return numerator to denominator, ready for `android.util.Rational`. */
    fun forVideo(width: Int, height: Int): Pair<Int, Int> {
        if (width <= 0 || height <= 0) return 16 to 9
        val ratio = width.toDouble() / height
        return when {
            ratio > MAX_RATIO -> (MAX_RATIO * SCALE).toInt() to SCALE
            ratio < MIN_RATIO -> SCALE to (MAX_RATIO * SCALE).toInt()
            else -> width to height
        }
    }
}
