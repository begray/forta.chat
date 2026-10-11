import { registerPlugin } from '@capacitor/core';
import { isNative } from '@/shared/lib/platform';

/** Bridge contract shared by the Android `TorFilePlugin.kt` (HTTP through
 *  Tor SOCKS at 127.0.0.1:8181) and the iOS `IOSTorFilePlugin.swift`
 *  (URLSession direct HTTPS — no Tor on iOS, per project decision).
 *
 *  Both implementations register under the JS-facing name `"TorFile"` so
 *  the call sites here pick the right native module without an isIOS
 *  branch.
 *
 *  `id` (optional) — caller-supplied progress identifier so concurrent
 *  uploads/downloads can be demultiplexed via the `progress` event.
 *  iOS and Android echo it back inside the event payload. Older native
 *  builds omit it, in which case the listener treats every event as
 *  matching the active call (single-transfer semantics). */
export interface TorFileNativePlugin {
  upload(options: {
    filePath: string;
    uploadUrl: string;
    mimeType: string;
    authorization?: string;
    id?: string;
  }): Promise<{ contentUri: string; statusCode: number }>;
  download(options: {
    url: string;
    authorization?: string;
    id?: string;
  }): Promise<{ filePath: string; mimeType: string; size: number }>;
  addListener(
    event: 'progress',
    cb: (data: { id?: string; percent: number; loaded: number; total: number }) => void,
  ): Promise<{ remove: () => void }>;
}

const TorFile = registerPlugin<TorFileNativePlugin>('TorFile');

/** `loaded` / `total` are bytes as reported by the native side. */
type ProgressCallback = (percent: number, loaded: number, total: number) => void;

/** Subscribe to native progress for one transfer. Each call gets its own
 *  listener: a shared one was replaced by the next transfer, so with several
 *  downloads in flight the earlier ones lost their progress. */
function listenProgress(
  id: string | undefined,
  onProgress: ProgressCallback,
): Promise<{ remove: () => void }> {
  return TorFile.addListener('progress', (data) => {
    // Filter only when both the caller supplied an id AND the native event
    // echoed one back. If either side omits it (older native builds, or
    // callers that do not care about per-transfer demux), accept every event.
    if (id && data.id && data.id !== id) return;
    onProgress(data.percent, data.loaded, data.total);
  });
}

class FileTransferService {
  async upload(options: {
    filePath: string;
    uploadUrl: string;
    mimeType: string;
    authorization?: string;
    /** Optional per-transfer identifier — see `TorFileNativePlugin.id`.
     *  Recommended: pass the Matrix `messageId` so the progress event
     *  can be matched back to the message bubble even when several
     *  uploads are in flight (chat with bulk forwards / share-target). */
    id?: string;
    onProgress?: ProgressCallback;
  }): Promise<string> {
    if (!isNative) {
      throw new Error('FileTransferService.upload() is native-only. Use fetch on web.');
    }

    const listener = options.onProgress
      ? await listenProgress(options.id, options.onProgress)
      : null;

    try {
      const result = await TorFile.upload({
        filePath: options.filePath,
        uploadUrl: options.uploadUrl,
        mimeType: options.mimeType,
        authorization: options.authorization,
        id: options.id,
      });
      return result.contentUri;
    } finally {
      listener?.remove();
    }
  }

  async download(options: {
    url: string;
    authorization?: string;
    /** Optional per-transfer identifier — see `TorFileNativePlugin.id`. */
    id?: string;
    onProgress?: ProgressCallback;
  }): Promise<{ filePath: string; mimeType: string }> {
    if (!isNative) {
      throw new Error('FileTransferService.download() is native-only.');
    }

    const listener = options.onProgress
      ? await listenProgress(options.id, options.onProgress)
      : null;

    try {
      const result = await TorFile.download({
        url: options.url,
        authorization: options.authorization,
        id: options.id,
      });
      return { filePath: result.filePath, mimeType: result.mimeType };
    } finally {
      listener?.remove();
    }
  }
}

export const fileTransferService = new FileTransferService();
