package com.forta.chat.plugins.videopip

import androidx.lifecycle.Lifecycle
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Expanding PiP back vs closing the window — only closing stops the video. */
class PipExitPolicyTest {

    @Test
    fun expandingBackToFullScreenIsNotADismissal() {
        assertFalse(PipExitPolicy.isDismissed(Lifecycle.State.STARTED))
        assertFalse(PipExitPolicy.isDismissed(Lifecycle.State.RESUMED))
    }

    @Test
    fun closingTheWindowLeavesTheActivityStopped_andCountsAsDismissal() {
        assertTrue(PipExitPolicy.isDismissed(Lifecycle.State.CREATED))
        assertTrue(PipExitPolicy.isDismissed(Lifecycle.State.DESTROYED))
    }
}
