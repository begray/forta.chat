package com.forta.chat.plugins.mediapicker

import java.io.File

/**
 * Pure helpers for the MediaPicker plugin's own copies (JVM-testable).
 *
 * Copies live in filesDir/picked/<batch>/; release and sweep refuse any path
 * outside that directory, so a bad argument from JS can never delete
 * anything else.
 */
object PickedFiles {
    const val DIR = "picked"
    private const val MAX_NAME = 80

    /** A file name safe to use inside the batch directory, keeping the extension. */
    fun safeName(index: Int, displayName: String?, fallbackExt: String): String {
        val raw = displayName?.substringAfterLast('/')?.trim().orEmpty()
        val ext = raw.substringAfterLast('.', "").takeIf { it.isNotEmpty() && it.length <= 5 && raw.contains('.') }
            ?.lowercase()?.replace(Regex("[^a-z0-9]"), "")
            ?.takeIf { it.isNotEmpty() }
            ?: fallbackExt
        val base = (if (raw.contains('.')) raw.substringBeforeLast('.') else raw)
            .replace(Regex("[^A-Za-z0-9_-]"), "_")
            .trim('_')
            .take(MAX_NAME)
            .ifEmpty { "item" }
        return "$index-$base.$ext"
    }

    /** Extension for a MIME type when the display name has none. */
    fun extensionFor(mime: String?): String = when {
        mime == null -> "bin"
        mime == "image/jpeg" -> "jpg"
        mime == "video/quicktime" -> "mov"
        mime.startsWith("image/") || mime.startsWith("video/") ->
            mime.substringAfter('/').replace(Regex("[^a-z0-9]"), "").take(5).ifEmpty { "bin" }
        else -> "bin"
    }

    /** True when [file] is strictly inside [root] (after resolving `..` and links). */
    fun isInside(root: File, file: File): Boolean {
        val r = root.canonicalFile
        val f = file.canonicalFile
        return f != r && f.path.startsWith(r.path + File.separator)
    }

    /** Should a picked item be copied now? Images always; videos up to
     *  [copyVideosUpTo] bytes (bigger ones are compressed straight from
     *  their URI), and only while the copy leaves [reserveBytes] free. */
    fun shouldCopy(isVideo: Boolean, size: Long, copyVideosUpTo: Long, freeBytes: Long, reserveBytes: Long): Boolean {
        if (size >= 0 && freeBytes - size < reserveBytes) return false
        if (!isVideo) return true
        return size in 0..copyVideosUpTo
    }
}
