package com.forta.chat.plugins.backgroundupload

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KeepAliveStateTest {

    private fun notice(percent: Int, title: String = "Sending 1 of 3 · $percent%", text: String = "Uploading") =
        KeepAliveNotice(title, text, percent, "Cancel")

    @Test
    fun progressRedrawsAndKeepsItAlive() {
        val s = KeepAliveState(idleLimitMs = 1000)
        s.start(notice(0), now = 0)
        assertTrue(s.update(notice(10), now = 900))
        assertFalse(s.isIdle(now = 1800))
        assertTrue(s.isIdle(now = 1900))
    }

    @Test
    fun theSameNoticeAgainIsNotProgress() {
        val s = KeepAliveState(idleLimitMs = 1000)
        s.start(notice(40), now = 0)
        assertFalse(s.update(notice(40), now = 500))
        assertFalse(s.update(notice(40), now = 999))
        assertTrue(s.isIdle(now = 1000))
    }

    @Test
    fun aPhaseChangeIsProgress() {
        val s = KeepAliveState(idleLimitMs = 1000)
        s.start(notice(50, text = "Compressing a video"), now = 0)
        assertTrue(s.update(notice(50, text = "Uploading"), now = 800))
        assertFalse(s.isIdle(now = 1500))
    }

    @Test
    fun percentIsClampedForTheProgressBar() {
        val s = KeepAliveState()
        s.start(notice(140), now = 0)
        assertEquals(100, s.notice!!.percent)
        s.update(notice(-5), now = 1)
        assertEquals(0, s.notice!!.percent)
    }

    @Test
    fun notIdleBeforeItStarted() {
        assertFalse(KeepAliveState(idleLimitMs = 1).isIdle(now = 1_000_000))
    }

    @Test
    fun defaultIdleLimitIsThirtyMinutes() {
        assertEquals(30 * 60 * 1000L, KeepAliveState.IDLE_LIMIT_MS)
    }
}
