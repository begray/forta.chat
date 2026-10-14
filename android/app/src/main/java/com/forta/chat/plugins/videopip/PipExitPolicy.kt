package com.forta.chat.plugins.videopip

import androidx.lifecycle.Lifecycle

/**
 * How the activity left PiP. Android reports both the same way
 * (`onPictureInPictureModeChanged(false)`); the lifecycle tells them apart:
 * expanding back brings the activity to STARTED, closing the window (X or
 * swipe away) leaves it stopped (CREATED). A closed window must stop the
 * video — otherwise its sound keeps playing with no UI on screen.
 */
object PipExitPolicy {
    fun isDismissed(state: Lifecycle.State): Boolean = !state.isAtLeast(Lifecycle.State.STARTED)
}
