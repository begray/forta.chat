package com.forta.chat.plugins.videocompress

import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.Presentation
import androidx.media3.transformer.AudioEncoderSettings
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File

/**
 * Re-encodes a phone video to H.264/AAC MP4 small enough for the server's
 * upload limit (Media3 Transformer, hardware codecs).
 *
 * JS API (see src/shared/lib/video-compress):
 *  - probe({ path }) -> { durationMs, width, height, rotation, bitrate, mime }
 *  - compress({ id, path, maxBytes, videoBitrate?, targetHeight = 720,
 *      audioBitrate = 128000 }) -> { path, uri, size, durationMs, width,
 *      height, videoBitrate }, with "progress" events { id, percent }
 *  - cancel({ id })
 *
 * `path` is an absolute path, a file:// or a content:// URI. Width/height in
 * results are display dimensions (rotation applied). HDR input is tone-mapped
 * to SDR so every recipient can play the result. Output files live in
 * cacheDir/video-compress; the caller deletes them after the send.
 */
// Opt in here rather than marking the class @UnstableApi, which would
// spread the opt-in requirement to MainActivity (lint error in release).
@OptIn(UnstableApi::class)
@CapacitorPlugin(name = "VideoCompress")
class VideoCompressPlugin : Plugin() {

    private class Job(
        val call: PluginCall,
        val transformer: Transformer,
        val output: File,
        val videoBitrate: Int,
    )

    /** Transformer must be driven from the looper it was built on. */
    private val main = Handler(Looper.getMainLooper())
    /** Touched on the main thread only. */
    private val jobs = HashMap<String, Job>()

    private data class Probe(
        val durationMs: Long,
        val width: Int,
        val height: Int,
        val rotation: Int,
        val bitrate: Int,
        val mime: String?,
    ) {
        val displayWidth get() = if (rotation % 180 != 0) height else width
        val displayHeight get() = if (rotation % 180 != 0) width else height
    }

    private fun toUri(path: String): Uri =
        if (path.startsWith("content://") || path.startsWith("file://")) Uri.parse(path)
        else Uri.fromFile(File(path))

    private fun probeUri(uri: Uri): Probe {
        val retriever = MediaMetadataRetriever()
        try {
            if (uri.scheme == "file") retriever.setDataSource(uri.path)
            else retriever.setDataSource(context, uri)
            fun meta(key: Int) = retriever.extractMetadata(key)
            return Probe(
                durationMs = meta(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0,
                width = meta(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0,
                height = meta(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0,
                rotation = meta(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0,
                bitrate = meta(MediaMetadataRetriever.METADATA_KEY_BITRATE)?.toIntOrNull() ?: 0,
                mime = meta(MediaMetadataRetriever.METADATA_KEY_MIMETYPE),
            )
        } finally {
            try { retriever.release() } catch (_: Exception) {}
        }
    }

    private fun Probe.toJs() = JSObject().apply {
        put("durationMs", durationMs)
        put("width", displayWidth)
        put("height", displayHeight)
        put("rotation", rotation)
        put("bitrate", bitrate)
        put("mime", mime)
    }

    @PluginMethod
    fun probe(call: PluginCall) {
        val path = call.getString("path") ?: return call.reject("path required")
        Thread {
            try {
                val probe = probeUri(toUri(path))
                if (probe.width <= 0 || probe.height <= 0) {
                    call.reject("Not a video: $path", "NOT_VIDEO")
                } else {
                    call.resolve(probe.toJs())
                }
            } catch (e: Exception) {
                call.reject("Cannot read the video: ${e.message}", "PROBE_FAILED", e)
            }
        }.start()
    }

    @PluginMethod
    fun compress(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("id required")
        val path = call.getString("path") ?: return call.reject("path required")
        val maxBytes = call.getLong("maxBytes") ?: 0L
        val targetHeight = call.getInt("targetHeight") ?: 720
        val audioBitrate = call.getInt("audioBitrate") ?: VideoCompressPlan.DEFAULT_AUDIO_BITRATE
        val requestedVideoBitrate = call.getInt("videoBitrate")

        Thread {
            val uri = toUri(path)
            val probe = try {
                probeUri(uri)
            } catch (e: Exception) {
                return@Thread call.reject("Cannot read the video: ${e.message}", "PROBE_FAILED", e)
            }
            val videoBitrate = requestedVideoBitrate?.let(VideoCompressPlan::clampVideoBitrate)
                ?: VideoCompressPlan.videoBitrateFor(probe.durationMs, maxBytes, audioBitrate)
                ?: return@Thread call.reject("The video is too long to fit $maxBytes bytes", "TOO_LONG")
            val dir = File(context.cacheDir, "video-compress").apply { mkdirs() }
            val output = File(dir, "out-${id.replace(Regex("[^A-Za-z0-9_-]"), "_")}.mp4")
            output.delete()
            main.post { start(id, call, uri, probe, targetHeight, videoBitrate, audioBitrate, output) }
        }.start()
    }

    private fun start(
        id: String,
        call: PluginCall,
        uri: Uri,
        probe: Probe,
        targetHeight: Int,
        videoBitrate: Int,
        audioBitrate: Int,
        output: File,
    ) {
        if (jobs.containsKey(id)) return call.reject("Job $id is already running", "BUSY")
        try {
            val encoderFactory = DefaultEncoderFactory.Builder(context)
                .setRequestedVideoEncoderSettings(VideoEncoderSettings.Builder().setBitrate(videoBitrate).build())
                // Requesting audio settings also forces an AAC re-encode, so a
                // 256-320 kbit/s camera track does not pass through unchanged.
                .setRequestedAudioEncoderSettings(AudioEncoderSettings.Builder().setBitrate(audioBitrate).build())
                .setEnableFallback(true)
                .build()
            val videoEffects = VideoCompressPlan.scaledShortSide(probe.width, probe.height, targetHeight)
                ?.let { listOf(Presentation.createForShortSide(it)) }
                ?: emptyList()
            val item = EditedMediaItem.Builder(MediaItem.fromUri(uri))
                .setEffects(Effects(emptyList(), videoEffects))
                .build()
            // The vararg builder infers the track types, so clips without
            // an audio track (screen recordings) still work.
            @Suppress("DEPRECATION")
            val sequence = EditedMediaItemSequence.Builder(item).build()
            val composition = Composition.Builder(sequence)
                .setHdrMode(Composition.HDR_MODE_TONE_MAP_HDR_TO_SDR_USING_OPEN_GL)
                .build()
            val transformer = Transformer.Builder(context)
                .setLooper(Looper.getMainLooper())
                .setVideoMimeType(MimeTypes.VIDEO_H264)
                .setAudioMimeType(MimeTypes.AUDIO_AAC)
                .setEncoderFactory(encoderFactory)
                .addListener(object : Transformer.Listener {
                    override fun onCompleted(composition: Composition, exportResult: ExportResult) {
                        finish(id) { job -> resolveDone(job, exportResult) }
                    }

                    override fun onError(
                        composition: Composition,
                        exportResult: ExportResult,
                        exportException: ExportException,
                    ) {
                        Log.w(TAG, "compress $id failed: ${exportException.errorCodeName}", exportException)
                        finish(id) { job ->
                            job.output.delete()
                            job.call.reject(
                                "Compression failed: ${exportException.errorCodeName} ${exportException.message ?: ""}".trim(),
                                "FAILED",
                                exportException,
                            )
                        }
                    }
                })
                .build()
            jobs[id] = Job(call, transformer, output, videoBitrate)
            transformer.start(composition, output.absolutePath)
            pollProgress(id)
        } catch (e: Exception) {
            jobs.remove(id)
            output.delete()
            call.reject("Compression could not start: ${e.message}", "FAILED", e)
        }
    }

    private val progress = ProgressHolder()

    private fun pollProgress(id: String) {
        val job = jobs[id] ?: return
        if (job.transformer.getProgress(progress) == Transformer.PROGRESS_STATE_AVAILABLE) {
            notifyListeners("progress", JSObject().apply {
                put("id", id)
                put("percent", progress.progress)
            })
        }
        main.postDelayed({ pollProgress(id) }, PROGRESS_INTERVAL_MS)
    }

    private inline fun finish(id: String, block: (Job) -> Unit) {
        val job = jobs.remove(id) ?: return
        block(job)
    }

    private fun resolveDone(job: Job, exportResult: ExportResult) {
        val size = job.output.length()
        val result = try { probeUri(Uri.fromFile(job.output)) } catch (_: Exception) { null }
        job.call.resolve(JSObject().apply {
            put("path", job.output.absolutePath)
            put("uri", Uri.fromFile(job.output).toString())
            put("size", size)
            put("durationMs", result?.durationMs ?: exportResult.approximateDurationMs)
            put("width", result?.displayWidth ?: exportResult.width)
            put("height", result?.displayHeight ?: exportResult.height)
            put("videoBitrate", job.videoBitrate)
        })
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("id required")
        main.post {
            val job = jobs.remove(id)
            if (job != null) {
                try { job.transformer.cancel() } catch (e: Exception) { Log.w(TAG, "cancel $id", e) }
                job.output.delete()
                job.call.reject("Compression cancelled", "CANCELLED")
            }
            call.resolve(JSObject().apply { put("cancelled", job != null) })
        }
    }

    override fun handleOnDestroy() {
        main.post {
            for ((_, job) in jobs) {
                try { job.transformer.cancel() } catch (_: Exception) {}
                job.output.delete()
                job.call.reject("Compression cancelled", "CANCELLED")
            }
            jobs.clear()
        }
        super.handleOnDestroy()
    }

    companion object {
        private const val TAG = "VideoCompress"
        private const val PROGRESS_INTERVAL_MS = 500L
    }
}
