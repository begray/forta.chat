package com.forta.chat.plugins.videocompress

import org.junit.Assert.assertEquals
import org.junit.Test

class VideoThumbTest {
    @Test
    fun grabsOneSecondInForLongClips() {
        assertEquals(1_000_000L, VideoThumb.frameTimeUs(42_000))
    }

    @Test
    fun grabsATenthOfShortClips() {
        assertEquals(300_000L, VideoThumb.frameTimeUs(3_000))
        assertEquals(0L, VideoThumb.frameTimeUs(0))
    }

    @Test
    fun fitsPortraitAndLandscapeWithoutUpscaling() {
        assertEquals(Pair(270, 480), VideoThumb.fitWithin(1080, 1920, 480))
        assertEquals(Pair(480, 270), VideoThumb.fitWithin(1920, 1080, 480))
        assertEquals(Pair(320, 240), VideoThumb.fitWithin(320, 240, 480))
        assertEquals(Pair(0, 0), VideoThumb.fitWithin(0, 240, 480))
    }
}
