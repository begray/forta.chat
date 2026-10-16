package com.forta.chat.plugins.mediapicker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class PickedFilesTest {
    private val MiB = 1024L * 1024

    @Test
    fun safeNameKeepsTheExtensionAndDropsPathTricks() {
        assertEquals("3-PXL_2026.mp4", PickedFiles.safeName(3, "PXL_2026.mp4", "bin"))
        assertEquals("0-etc_passwd.jpg", PickedFiles.safeName(0, "../../etc passwd.JPG", "bin"))
        assertEquals("1-item.jpg", PickedFiles.safeName(1, null, "jpg"))
        assertEquals("2-noext.mp4", PickedFiles.safeName(2, "noext", "mp4"))
    }

    @Test
    fun extensionComesFromTheMimeType() {
        assertEquals("jpg", PickedFiles.extensionFor("image/jpeg"))
        assertEquals("mov", PickedFiles.extensionFor("video/quicktime"))
        assertEquals("mp4", PickedFiles.extensionFor("video/mp4"))
        assertEquals("bin", PickedFiles.extensionFor(null))
    }

    @Test
    fun isInsideOnlyAcceptsFilesUnderTheRoot() {
        val tmp = Files.createTempDirectory("picked-test").toFile()
        try {
            val root = File(tmp, "picked").apply { mkdirs() }
            val batch = File(root, "b1").apply { mkdirs() }
            assertTrue(PickedFiles.isInside(root, File(batch, "0-a.jpg")))
            assertFalse(PickedFiles.isInside(root, root))
            assertFalse(PickedFiles.isInside(root, File(root, "../other.jpg")))
            assertFalse(PickedFiles.isInside(root, File(tmp, "picked-evil/x.jpg")))
            assertFalse(PickedFiles.isInside(root, File("/data/user/0/app/cache/video-compress/in-x.mp4")))
        } finally {
            tmp.deleteRecursively()
        }
    }

    @Test
    fun imagesAndSmallVideosAreCopiedBigVideosStayOnTheirUri() {
        val free = 10_000 * MiB
        val reserve = 300 * MiB
        assertTrue(PickedFiles.shouldCopy(false, 8 * MiB, 15 * MiB, free, reserve))
        assertTrue(PickedFiles.shouldCopy(true, 9 * MiB, 15 * MiB, free, reserve))
        assertFalse(PickedFiles.shouldCopy(true, 92 * MiB, 15 * MiB, free, reserve))
        assertFalse(PickedFiles.shouldCopy(true, -1, 15 * MiB, free, reserve))
        // A nearly full phone keeps even photos on their URI.
        assertFalse(PickedFiles.shouldCopy(false, 8 * MiB, 15 * MiB, 305 * MiB, reserve))
    }
}
