package com.forta.chat.plugins.videocompress

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VideoCompressPlanTest {
    private val limit = 52_428_800L // 50 MiB

    @Test
    fun shortClipGetsTheQualityCeiling() {
        assertEquals(VideoCompressPlan.MAX_VIDEO_BITRATE, VideoCompressPlan.videoBitrateFor(30_000, limit))
    }

    @Test
    fun threeMinuteClipFitsWithTheMargin() {
        val durationMs = 180_000L
        val video = VideoCompressPlan.videoBitrateFor(durationMs, limit)!!
        val bytes = (video + VideoCompressPlan.DEFAULT_AUDIO_BITRATE) / 8.0 * durationMs / 1000
        assertTrue("$bytes must leave ~10 % of $limit", bytes <= limit * 0.9 + 1)
        assertTrue(video in VideoCompressPlan.MIN_VIDEO_BITRATE until VideoCompressPlan.MAX_VIDEO_BITRATE)
    }

    @Test
    fun tooLongClipHasNoBitrate() {
        assertNull(VideoCompressPlan.videoBitrateFor(20 * 60_000L, limit))
    }

    @Test
    fun unknownDurationHasNoBitrate() {
        assertNull(VideoCompressPlan.videoBitrateFor(0, limit))
    }

    @Test
    fun clampKeepsRequestsInRange() {
        assertEquals(VideoCompressPlan.MIN_VIDEO_BITRATE, VideoCompressPlan.clampVideoBitrate(1))
        assertEquals(1_000_000, VideoCompressPlan.clampVideoBitrate(1_000_000))
    }

    @Test
    fun scalesTheShortSideInBothOrientations() {
        assertEquals(720, VideoCompressPlan.scaledShortSide(1920, 1080, 720))
        assertEquals(720, VideoCompressPlan.scaledShortSide(1080, 1920, 720))
        assertNull(VideoCompressPlan.scaledShortSide(1280, 720, 720))
        assertNull(VideoCompressPlan.scaledShortSide(640, 480, 720))
    }

    @Test
    fun scaledSizeIsEven() {
        assertEquals(1280 to 720, VideoCompressPlan.scaledSize(1920, 1080, 720))
        assertEquals(720 to 1280, VideoCompressPlan.scaledSize(1080, 1920, 720))
        val (w, h) = VideoCompressPlan.scaledSize(1440, 1080, 480)
        assertEquals(0, w % 2)
        assertEquals(480, h)
    }
}
