import { Capacitor } from '@capacitor/core';
import { isAndroid } from '@/shared/lib/platform';
import { torService } from '@/shared/lib/tor/tor-service';
import { fileTransferService } from './file-transfer-service';
import { DownloadStalledError, type TransferProgress } from './fetch-blob-with-progress';

/** Stream large uploads through TorFile instead of the WebView XHR path. */
export const NATIVE_TOR_UPLOAD_THRESHOLD_BYTES = 5 * 1024 * 1024;

/**
 * What an upload through Tor is assumed to carry, for the progress estimate only.
 * Measured on the Samsung bench: 6 MB in 47 s, about 130 KB/s (2026-09-19).
 */
const ASSUMED_TOR_UPLOAD_BYTES_PER_SEC = 100 * 1024;
const ESTIMATE_CEILING_PERCENT = 95;
const ESTIMATE_TICK_MS = 1000;

/**
 * Upload progress to show for a file going through Tor.
 *
 * The plugin reports the bytes it handed to the local reverse proxy, which takes the
 * whole body within a second and then spends the real time pushing it through Tor:
 * the ring filled to 100 % at once and sat there for 45 s. Nothing downstream reports
 * how much has left the phone, so the ring follows the time a file of this size is
 * expected to take, never runs ahead of the hand-off, and stops short of full until
 * the server has answered.
 */
export function estimateTorUploadPercent(handedOverPercent: number, elapsedMs: number, sizeBytes: number): number {
  const expectedMs = Math.max(1000, (sizeBytes / ASSUMED_TOR_UPLOAD_BYTES_PER_SEC) * 1000);
  const byTime = (ESTIMATE_CEILING_PERCENT * Math.max(0, elapsedMs)) / expectedMs;
  return Math.floor(Math.max(0, Math.min(ESTIMATE_CEILING_PERCENT, handedOverPercent, byTime)));
}

export interface MediaUploadEndpoint {
  url: string;
  authorization: string;
}

export interface UploadMediaViaTorFileOptions {
  blob: Blob;
  mimeType: string;
  getUploadEndpoint: () => MediaUploadEndpoint;
  onProgress?: (progress: { loaded: number; total: number }) => void;
  signal?: AbortSignal;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1] ?? '');
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function extensionForMime(mimeType: string): string {
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return '.jpg';
  if (mimeType.includes('png')) return '.png';
  if (mimeType.includes('gif')) return '.gif';
  if (mimeType.includes('webp')) return '.webp';
  if (mimeType.includes('mp4')) return '.mp4';
  if (mimeType.includes('webm')) return '.webm';
  if (mimeType.includes('pdf')) return '.pdf';
  if (mimeType.includes('ogg')) return '.ogg';
  return '.bin';
}

export function isTorMediaTransferActive(): boolean {
  if (!isAndroid) return false;
  if (torService.mode.value === 'neveruse') return false;
  if (!torService.isReady.value || torService.initFailed.value) return false;
  return torService.matrixBaseUrl.length > 0;
}

export function shouldUseNativeTorUpload(fileSizeBytes: number): boolean {
  return isTorMediaTransferActive() && fileSizeBytes >= NATIVE_TOR_UPLOAD_THRESHOLD_BYTES;
}

export function shouldUseNativeTorDownload(): boolean {
  return isTorMediaTransferActive();
}

export function parseMatrixUploadResponse(body: string): string {
  const trimmed = body.trim();
  if (trimmed.startsWith('mxc://')) return trimmed;

  const parsed = JSON.parse(trimmed) as { content_uri?: string };
  if (!parsed.content_uri) {
    throw new Error('Matrix upload response missing content_uri');
  }
  return parsed.content_uri;
}

async function deleteCacheUpload(path: string): Promise<void> {
  try {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    await Filesystem.deleteFile({ path, directory: Directory.Cache });
  } catch {
    // Best-effort cleanup — cache eviction will reclaim the file.
  }
}

/** Upload encrypted/plain media through TorFile → reverse proxy :8181. */
export async function uploadMediaViaTorFile(
  options: UploadMediaViaTorFileOptions,
): Promise<string> {
  if (options.signal?.aborted) {
    throw new DOMException('Upload cancelled', 'AbortError');
  }

  const { blob, mimeType, getUploadEndpoint, onProgress, signal } = options;
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const cachePath = `tor-upload-${Date.now()}${extensionForMime(mimeType)}`;
  const base64 = await blobToBase64(blob);

  await Filesystem.writeFile({
    path: cachePath,
    data: base64,
    directory: Directory.Cache,
  });

  const { uri } = await Filesystem.getUri({
    directory: Directory.Cache,
    path: cachePath,
  });

  let handedOverPercent = 0;
  const startedAt = Date.now();
  const report = (): void => {
    const percent = estimateTorUploadPercent(handedOverPercent, Date.now() - startedAt, blob.size);
    onProgress?.({ loaded: Math.round((blob.size * percent) / 100), total: blob.size });
  };
  const ticker = onProgress ? setInterval(report, ESTIMATE_TICK_MS) : null;

  try {
    const { url, authorization } = getUploadEndpoint();
    const responseBody = await fileTransferService.upload({
      filePath: uri,
      uploadUrl: url,
      mimeType,
      authorization,
      onProgress: onProgress
        ? (percent) => {
            handedOverPercent = percent;
            report();
          }
        : undefined,
    });

    if (signal?.aborted) {
      throw new DOMException('Upload cancelled', 'AbortError');
    }

    return parseMatrixUploadResponse(responseBody);
  } finally {
    if (ticker !== null) clearInterval(ticker);
    await deleteCacheUpload(cachePath);
  }
}

/** Backup deadline between two native progress events. The plugin reports at
 *  least once a second while bytes flow and fails a silent socket after 60 s
 *  (read timeout); this covers native builds that predate both. */
export const TOR_DOWNLOAD_IDLE_TIMEOUT_MS = 120_000;

export interface DownloadMediaViaTorFileOptions {
  authorization?: string;
  onProgress?: (progress: TransferProgress) => void;
  /** Rejects with AbortError when aborted. The native transfer has no cancel
   *  call, so it finishes in the background and its result is dropped. */
  signal?: AbortSignal;
  idleTimeoutMs?: number;
}

let torDownloadSeq = 0;

/** Download media bytes through TorFile → reverse proxy :8181. */
export async function downloadMediaViaTorFile(
  url: string,
  options: DownloadMediaViaTorFileOptions = {},
): Promise<Blob> {
  const { authorization, onProgress, signal } = options;
  const idleTimeoutMs = options.idleTimeoutMs ?? TOR_DOWNLOAD_IDLE_TIMEOUT_MS;
  if (signal?.aborted) throw new DOMException('Download cancelled', 'AbortError');

  // Idle deadline + caller abort, raced against the native transfer.
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The native call cannot be cancelled: after a cancel or a stall its
  // listener keeps firing until it ends. Drop those events so they neither
  // re-arm timers nor move the progress of the next attempt.
  let isSettled = false;
  let rejectGuard: (err: Error) => void = () => {};
  const guard = new Promise<never>((_, reject) => { rejectGuard = reject; });
  const rearm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => rejectGuard(new DownloadStalledError('body', idleTimeoutMs)), idleTimeoutMs);
  };
  const onAbort = () => rejectGuard(new DOMException('Download cancelled', 'AbortError'));
  signal?.addEventListener('abort', onAbort, { once: true });
  rearm();

  try {
    const transfer = fileTransferService.download({
      url,
      authorization,
      id: `tor-dl-${++torDownloadSeq}`,
      onProgress: (_percent, loaded, total) => {
        if (isSettled) return;
        rearm();
        onProgress?.({ loaded, total });
      },
    });
    // The losing transfer may still reject later; keep that off the console.
    transfer.catch(() => {});
    const { filePath, mimeType } = await Promise.race([transfer, guard]);

    const webPath = Capacitor.convertFileSrc(filePath);
    const response = await fetch(webPath);
    if (!response.ok) {
      throw new Error(`Failed to read Tor download: ${response.status}`);
    }

    const blob = await response.blob();
    return mimeType ? new Blob([blob], { type: mimeType }) : blob;
  } finally {
    isSettled = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
