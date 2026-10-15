package com.forta.chat.plugins.videocompress

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Pure size/bitrate maths for [VideoCompressPlugin] (JVM-testable).
 *
 * The JS side (`video-compress-plan.ts`) owns the policy and normally passes
 * an explicit video bitrate; this mirror is the native fallback when it does
 * not, and the clamp that keeps a bad value from reaching the encoder.
 */
object VideoCompressPlan {
    /** Share of maxBytes left for the MP4 container, the encoder's overshoot
     *  and the encryption padding. */
    const val SIZE_MARGIN = 0.10
    const val DEFAULT_AUDIO_BITRATE = 128_000
    /** Below this a 720p/480p H.264 picture falls apart. */
    const val MIN_VIDEO_BITRATE = 450_000
    /** Messenger-grade 720p; more only makes short clips bigger. */
    const val MAX_VIDEO_BITRATE = 2_500_000
    const val MAX_ACCEPTED_BITRATE = 20_000_000

    /**
     * Video bitrate (bit/s) that makes [durationMs] of video plus
     * [audioBitrate] fit into [maxBytes] with [SIZE_MARGIN] to spare, capped
     * at [ceiling]. Null when even [MIN_VIDEO_BITRATE] does not fit (the
     * video is too long) or the duration is unknown.
     */
    fun videoBitrateFor(
        durationMs: Long,
        maxBytes: Long,
        audioBitrate: Int = DEFAULT_AUDIO_BITRATE,
        ceiling: Int = MAX_VIDEO_BITRATE,
    ): Int? {
        if (durationMs <= 0 || maxBytes <= 0) return null
        val seconds = durationMs / 1000.0
        val budget = maxBytes * 8.0 * (1 - SIZE_MARGIN) / seconds - audioBitrate
        if (budget < MIN_VIDEO_BITRATE) return null
        return min(budget, ceiling.toDouble()).toInt()
    }

    /** A caller-supplied bitrate, kept within sane encoder bounds. */
    fun clampVideoBitrate(requested: Int): Int =
        requested.coerceIn(MIN_VIDEO_BITRATE, MAX_ACCEPTED_BITRATE)

    /**
     * The short side to scale to, or null when the video is already no
     * bigger than [targetShortSide] (never upscale). Width/height may be in
     * either orientation; the short side is what "720p" means for portrait
     * phone videos too.
     */
    fun scaledShortSide(width: Int, height: Int, targetShortSide: Int): Int? {
        if (width <= 0 || height <= 0 || targetShortSide <= 0) return null
        val shortSide = min(width, height)
        return if (shortSide > targetShortSide) targetShortSide else null
    }

    /** Output dimensions after scaling the short side to [shortSide], rounded
     *  to even numbers (H.264 encoders want them). */
    fun scaledSize(width: Int, height: Int, shortSide: Int): Pair<Int, Int> {
        val scale = shortSide.toDouble() / min(width, height)
        fun even(v: Double) = max(2, (v / 2).roundToInt() * 2)
        return even(width * scale) to even(height * scale)
    }
}
