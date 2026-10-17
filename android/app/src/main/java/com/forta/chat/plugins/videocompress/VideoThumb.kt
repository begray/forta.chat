package com.forta.chat.plugins.videocompress

/** Sizing and timing of an m.video poster frame (pure, unit-tested). */
object VideoThumb {
    const val DEFAULT_MAX_SIZE = 480
    const val DEFAULT_QUALITY = 78

    /** Where to grab the frame: 1 s in, or a tenth of a short clip, which
     *  skips the black or blurry first frame many phones record. */
    fun frameTimeUs(durationMs: Long): Long {
        if (durationMs <= 0) return 0
        return minOf(1_000L, durationMs / 10) * 1_000L
    }

    /** Scale (w, h) so the long side is at most maxSize; never upscale. */
    fun fitWithin(width: Int, height: Int, maxSize: Int): Pair<Int, Int> {
        if (width <= 0 || height <= 0) return Pair(0, 0)
        val longest = maxOf(width, height)
        if (longest <= maxSize) return Pair(width, height)
        val scale = maxSize.toDouble() / longest
        return Pair(maxOf(1, Math.round(width * scale).toInt()), maxOf(1, Math.round(height * scale).toInt()))
    }
}
