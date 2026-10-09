package com.forta.chat.plugins.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Regression: the move to the `fortachat` Firebase project (2026-10) left the
 * device's old pusher on the homeserver, and every message rang twice — once
 * through each project.
 */
class PushSenderPolicyTest {

    private val own = listOf("792979239739", "fortachat")

    @Test
    fun `drops a push from another Firebase project once our pusher is live`() {
        assertFalse(PushSenderPolicy.shouldDeliver("111111111111", own, isOwnPusherLive = true))
    }

    @Test
    fun `delivers a push from our project by sender number or project id`() {
        assertTrue(PushSenderPolicy.shouldDeliver("792979239739", own, isOwnPusherLive = true))
        assertTrue(PushSenderPolicy.shouldDeliver("fortachat", own, isOwnPusherLive = true))
    }

    @Test
    fun `delivers everything until our pusher is live`() {
        // An update the user has not opened yet: the old pusher is its only delivery path.
        assertTrue(PushSenderPolicy.shouldDeliver("111111111111", own, isOwnPusherLive = false))
    }

    @Test
    fun `delivers when the sender or our own project is unknown`() {
        assertTrue(PushSenderPolicy.shouldDeliver(null, own, isOwnPusherLive = true))
        assertTrue(PushSenderPolicy.shouldDeliver("", own, isOwnPusherLive = true))
        assertTrue(PushSenderPolicy.shouldDeliver("111111111111", emptyList(), isOwnPusherLive = true))
        assertTrue(PushSenderPolicy.shouldDeliver("111111111111", listOf(null, " "), isOwnPusherLive = true))
    }

    @Test
    fun `a rotation keeps the replaced token as legacy`() {
        assertEquals("old", PushSenderPolicy.legacyTokenAfterRotation("old", "new", null))
    }

    @Test
    fun `no legacy without a real rotation`() {
        assertNull(PushSenderPolicy.legacyTokenAfterRotation(null, "new", null))
        assertNull(PushSenderPolicy.legacyTokenAfterRotation("same", "same", null))
    }

    @Test
    fun `a second rotation keeps the oldest legacy token`() {
        // old project -> new token A -> new token B before JS ran: the old-project pusher must still go.
        assertEquals("old", PushSenderPolicy.legacyTokenAfterRotation("tokenA", "tokenB", "old"))
    }
}
