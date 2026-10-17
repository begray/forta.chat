package com.forta.chat.plugins.mediapicker

import android.content.Intent
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.OpenableColumns
import android.util.Log
import android.util.Size
import androidx.activity.result.ActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.io.FileOutputStream

/**
 * Picks photos and videos with the Android photo picker and makes them safe
 * to send later (see src/shared/lib/media-picker).
 *
 * Why: files picked through <input type=file> reach JS as WebView File
 * handles on the provider's content:// URIs, read lazily. In a 19-item batch
 * every unread handle failed with NotReadableError ~20 s after the pick
 * (standbyfix6 log), so 14 items were lost. Here each item is settled right
 * after the pick, before anything slow runs:
 *  - images and small videos are stream-copied into filesDir/picked/<batch>/;
 *  - big videos (to be compressed) stay on their content:// URI, which
 *    Media3 reads directly; we take a persistable read grant where the
 *    provider offers one, and probe the video once to prove it opens.
 *
 * JS API:
 *  - pick({ copyVideosUpTo }) -> { cancelled, items: [{ index, name, mime,
 *      size, kind, copied, uri, path?, durationMs?, width?, height?,
 *      thumbUri?, error? }], ms, authority }
 *  - release({ paths, uris }): delete our copies (only inside picked/) and
 *    give back persisted grants.
 *  - sweep({ olderThanMs }): drop leftovers of crashed sessions.
 */
@CapacitorPlugin(name = "MediaPicker")
class MediaPickerPlugin : Plugin() {

    private val pickedRoot get() = File(context.filesDir, PickedFiles.DIR)
    private val thumbRoot get() = File(context.cacheDir, "picked-thumbs")

    @PluginMethod
    fun pick(call: PluginCall) {
        val request = PickVisualMediaRequest.Builder()
            .setMediaType(ActivityResultContracts.PickVisualMedia.ImageAndVideo)
            .build()
        val intent = try {
            ActivityResultContracts.PickMultipleVisualMedia().createIntent(context, request)
        } catch (e: Exception) {
            return call.reject("The photo picker is not available: ${e.message}", "UNAVAILABLE", e)
        }
        startActivityForResult(call, intent, "onPicked")
    }

    @ActivityCallback
    private fun onPicked(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val uris = try {
            ActivityResultContracts.PickMultipleVisualMedia().parseResult(result.resultCode, result.data)
        } catch (e: Exception) {
            emptyList()
        }
        if (uris.isEmpty()) {
            call.resolve(JSObject().apply {
                put("cancelled", true)
                put("items", JSArray())
            })
            return
        }
        val copyVideosUpTo = call.getLong("copyVideosUpTo") ?: DEFAULT_COPY_VIDEOS_UP_TO
        Thread {
            val started = SystemClock.elapsedRealtime()
            val batch = File(pickedRoot, "b${System.currentTimeMillis()}").apply { mkdirs() }
            val items = JSArray()
            uris.forEachIndexed { index, uri ->
                items.put(settle(index, uri, batch, copyVideosUpTo))
                notifyListeners("pickProgress", JSObject().apply {
                    put("done", index + 1)
                    put("total", uris.size)
                })
            }
            if (batch.list().isNullOrEmpty()) batch.delete()
            call.resolve(JSObject().apply {
                put("cancelled", false)
                put("items", items)
                put("ms", SystemClock.elapsedRealtime() - started)
                // Only the provider, never a path: tells the photo picker
                // (media) from a document provider in the upload log.
                put("authority", uris.first().authority ?: "")
            })
        }.start()
    }

    private data class Meta(val name: String?, val size: Long)

    private fun queryMeta(uri: Uri): Meta {
        var name: String? = null
        var size = -1L
        try {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)
                ?.use { c ->
                    if (c.moveToFirst()) {
                        val n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        val s = c.getColumnIndex(OpenableColumns.SIZE)
                        if (n >= 0 && !c.isNull(n)) name = c.getString(n)
                        if (s >= 0 && !c.isNull(s)) size = c.getLong(s)
                    }
                }
        } catch (e: Exception) {
            Log.w(TAG, "query failed", e)
        }
        return Meta(name, size)
    }

    /** Copy or pin one picked item; never throws (errors go into the item). */
    private fun settle(index: Int, uri: Uri, batch: File, copyVideosUpTo: Long): JSObject {
        val item = JSObject()
        item.put("index", index)
        val mime = try { context.contentResolver.getType(uri) } catch (_: Exception) { null }
        val meta = queryMeta(uri)
        val isVideo = mime?.startsWith("video/") == true
        val name = meta.name ?: "${if (isVideo) "video" else "photo"}-${index + 1}.${PickedFiles.extensionFor(mime)}"
        item.put("name", name)
        item.put("mime", mime ?: "application/octet-stream")
        item.put("kind", if (isVideo) "video" else "image")
        item.put("size", meta.size)
        try {
            val copy = PickedFiles.shouldCopy(isVideo, meta.size, copyVideosUpTo, batch.usableSpace, RESERVE_BYTES)
            if (copy) {
                val out = File(batch, PickedFiles.safeName(index, meta.name, PickedFiles.extensionFor(mime)))
                val input = context.contentResolver.openInputStream(uri)
                    ?: throw IllegalStateException("The provider returned no stream")
                val copied = input.use { src -> FileOutputStream(out).use { dst -> src.copyTo(dst, COPY_BUFFER) } }
                if (copied <= 0L) {
                    out.delete()
                    throw IllegalStateException("The file is empty")
                }
                item.put("copied", true)
                item.put("size", copied)
                item.put("path", out.absolutePath)
                item.put("uri", Uri.fromFile(out).toString())
                if (isVideo) describeVideo(item, Uri.fromFile(out), out, index, batch.name)
            } else {
                pinGrant(uri)
                item.put("copied", false)
                item.put("uri", uri.toString())
                // Opening it once now proves it is readable, and gives the
                // duration/size the composer shows.
                if (isVideo) describeVideo(item, uri, null, index, batch.name)
            }
        } catch (e: Exception) {
            Log.w(TAG, "item $index could not be read", e)
            item.put("copied", false)
            item.put("error", "${e.javaClass.simpleName}: ${e.message ?: ""}".trim())
        }
        return item
    }

    private fun pinGrant(uri: Uri) {
        try {
            context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (_: SecurityException) {
            // Not persistable here; the activity's grant still covers this session.
        }
    }

    private fun describeVideo(item: JSObject, uri: Uri, file: File?, index: Int, batchName: String) {
        val retriever = MediaMetadataRetriever()
        try {
            if (file != null) retriever.setDataSource(file.absolutePath) else retriever.setDataSource(context, uri)
            fun meta(key: Int) = retriever.extractMetadata(key)
            val rotation = meta(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
            val w = meta(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
            val h = meta(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
            item.put("durationMs", meta(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0)
            item.put("width", if (rotation % 180 != 0) h else w)
            item.put("height", if (rotation % 180 != 0) w else h)
            val frame = thumbnail(uri, retriever)
            if (frame != null) {
                val thumb = File(thumbRoot, "$batchName-$index.jpg")
                thumbRoot.mkdirs()
                FileOutputStream(thumb).use { frame.compress(Bitmap.CompressFormat.JPEG, 80, it) }
                frame.recycle()
                item.put("thumbUri", Uri.fromFile(thumb).toString())
            }
        } catch (e: Exception) {
            if (file == null) throw e // the URI itself does not open: report it
            Log.w(TAG, "video $index: no metadata", e)
        } finally {
            try { retriever.release() } catch (_: Exception) {}
        }
    }

    private fun thumbnail(uri: Uri, retriever: MediaMetadataRetriever): Bitmap? = try {
        if (Build.VERSION.SDK_INT >= 29 && uri.scheme == "content") {
            context.contentResolver.loadThumbnail(uri, Size(THUMB_PX, THUMB_PX), null)
        } else {
            retriever.getFrameAtTime(0)?.let { full ->
                val scale = THUMB_PX.toFloat() / maxOf(full.width, full.height)
                if (scale >= 1f) full
                else Bitmap.createScaledBitmap(full, (full.width * scale).toInt(), (full.height * scale).toInt(), true)
                    .also { if (it !== full) full.recycle() }
            }
        }
    } catch (_: Exception) {
        null
    }

    @PluginMethod
    fun release(call: PluginCall) {
        val paths = call.getArray("paths")?.toList<String>() ?: emptyList()
        val uris = call.getArray("uris")?.toList<String>() ?: emptyList()
        Thread {
            var deleted = 0
            for (p in paths) {
                val f = File(p)
                // Only our own copies: anything else is left alone.
                if (!PickedFiles.isInside(pickedRoot, f)) continue
                if (f.delete()) deleted++
                val dir = f.parentFile
                if (dir != null && PickedFiles.isInside(pickedRoot, dir) && dir.list().isNullOrEmpty()) dir.delete()
            }
            for (u in uris) {
                val uri = Uri.parse(u)
                if (uri.scheme == "file") {
                    val f = File(uri.path ?: continue)
                    if (PickedFiles.isInside(thumbRoot, f)) f.delete()
                    continue
                }
                try {
                    context.contentResolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                } catch (_: Exception) {
                    // Never persisted (or already released).
                }
            }
            call.resolve(JSObject().apply { put("deleted", deleted) })
        }.start()
    }

    @PluginMethod
    fun sweep(call: PluginCall) {
        val olderThanMs = call.getLong("olderThanMs") ?: SWEEP_AGE_MS
        Thread {
            val cutoff = System.currentTimeMillis() - olderThanMs
            var removed = 0
            pickedRoot.listFiles()?.forEach { dir ->
                if (dir.lastModified() < cutoff && PickedFiles.isInside(pickedRoot, dir)) {
                    if (dir.deleteRecursively()) removed++
                }
            }
            thumbRoot.listFiles()?.forEach { if (it.lastModified() < cutoff) it.delete() }
            // We take read grants only for picked videos and give them back
            // after the send; old ones are leftovers of a crash.
            try {
                for (p in context.contentResolver.persistedUriPermissions) {
                    if (p.isReadPermission && !p.isWritePermission && p.persistedTime < cutoff) {
                        try {
                            context.contentResolver.releasePersistableUriPermission(p.uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        } catch (_: Exception) {}
                    }
                }
            } catch (_: Exception) {}
            call.resolve(JSObject().apply { put("removed", removed) })
        }.start()
    }

    companion object {
        private const val TAG = "MediaPicker"
        private const val COPY_BUFFER = 256 * 1024
        private const val THUMB_PX = 320
        /** Keep this much storage free when copying. */
        private const val RESERVE_BYTES = 300L * 1024 * 1024
        private const val DEFAULT_COPY_VIDEOS_UP_TO = 15L * 1024 * 1024
        private const val SWEEP_AGE_MS = 6L * 60 * 60 * 1000
    }
}
