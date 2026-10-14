package com.forta.chat.plugins.videopip

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Android throws on a PiP ratio outside 1:2.39 … 2.39:1, so every video size
 * must map into that range before reaching `PictureInPictureParams`.
 */
class PipAspectRatioTest {

    @Test
    fun aRegularVideoKeepsItsOwnRatio() {
        assertEquals(1280 to 720, PipAspectRatio.forVideo(1280, 720))
        // Vertical phone video from a channel (PeerTube 720x960).
        assertEquals(720 to 960, PipAspectRatio.forVideo(720, 960))
    }

    @Test
    fun anUltraWideVideoIsClampedToTheWidestAllowedRatio() {
        val (num, den) = PipAspectRatio.forVideo(3000, 1000)
        assertEquals(2.39, num.toDouble() / den, 0.001)
    }

    @Test
    fun anUltraTallVideoIsClampedToTheTallestAllowedRatio() {
        val (num, den) = PipAspectRatio.forVideo(720, 2000)
        assertEquals(1 / 2.39, num.toDouble() / den, 0.001)
    }

    @Test
    fun anUnknownSizeFallsBackTo16by9() {
        assertEquals(16 to 9, PipAspectRatio.forVideo(0, 0))
        assertEquals(16 to 9, PipAspectRatio.forVideo(1280, -1))
    }
}
